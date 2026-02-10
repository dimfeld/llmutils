import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLineSplitter, spawnAndLogOutput } from '../../common/process.js';
import { debugLog, runWithLogger, warn } from '../../logging.js';
import type { LoggerAdapter } from '../../logging/adapter.js';
import { formatStructuredMessage } from '../../logging/console_formatter.js';
import type { StructuredMessage } from '../../logging/structured_messages.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { TIM_OUTPUT_SOCKET } from '../../logging/tunnel_protocol.js';
import { createTunnelServer, type TunnelServer } from '../../logging/tunnel_server.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { codexReasoningLevelSchema, type CodexReasoningLevel } from '../executors/schemas.js';
import {
  extractStructuredMessages,
  formatJsonMessage,
  resetToolUseCache,
} from '../executors/claude_code/format.js';
import { createCodexStdoutFormatter } from '../executors/codex_cli/format.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';

type ExecutorAlias = 'claude' | 'codex';
const RUN_PROMPT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const RUN_PROMPT_INITIAL_INACTIVITY_TIMEOUT_MS = 60 * 1000; // 1 minute

export interface RunPromptCommandOptions {
  executor?: string;
  model?: string;
  reasoningLevel?: string;
  jsonSchema?: string;
  promptFile?: string;
  quiet?: boolean;
}

type PromptResolverDeps = {
  readFile?: (filePath: string) => Promise<string>;
  readStdin?: () => Promise<string>;
};

type SchemaResolverDeps = {
  cwd?: string;
  readFile?: (filePath: string) => Promise<string>;
};

const runPromptStderrLogger: LoggerAdapter = {
  log: (...args: any[]) => {
    console.error(...args);
  },
  warn: (...args: any[]) => {
    console.error(...args);
  },
  error: (...args: any[]) => {
    console.error(...args);
  },
  writeStdout: (data: string) => {
    process.stderr.write(data);
  },
  writeStderr: (data: string) => {
    process.stderr.write(data);
  },
  debugLog: (...args: any[]) => {
    console.error(...args);
  },
  sendStructured: (message: StructuredMessage) => {
    const formatted = formatStructuredMessage(message);
    if (formatted.length > 0) {
      console.error(formatted);
    }
  },
};

const runPromptQuietLogger: LoggerAdapter = {
  log: () => {},
  warn: () => {},
  error: () => {},
  writeStdout: () => {},
  writeStderr: () => {},
  debugLog: () => {},
  sendStructured: () => {},
};

export function resolveExecutorAlias(input: string | undefined): ExecutorAlias {
  const executor = (input ?? 'claude').trim().toLowerCase();
  if (executor === 'claude' || executor === 'claude-code') {
    return 'claude';
  }
  if (executor === 'codex' || executor === 'codex-cli') {
    return 'codex';
  }

  throw new Error(
    `Unsupported executor "${input}". Valid values are "claude", "claude-code", "codex", and "codex-cli".`
  );
}

export function resolveReasoningLevel(value: string | undefined): CodexReasoningLevel | undefined {
  if (value == null) {
    return undefined;
  }
  return codexReasoningLevelSchema.parse(value);
}

export function shouldAllowAllTools(envValue: string | undefined): boolean {
  if (!envValue) {
    return false;
  }
  return ['true', '1'].includes(envValue.trim().toLowerCase());
}

export async function resolveJsonSchemaOption(
  jsonSchemaOption: string | undefined,
  deps: SchemaResolverDeps = {}
): Promise<string | undefined> {
  if (!jsonSchemaOption) {
    return undefined;
  }

  const readFile = deps.readFile ?? ((filePath: string) => Bun.file(filePath).text());
  const cwd = deps.cwd ?? process.cwd();
  const trimmed = jsonSchemaOption.trim();
  let schema = trimmed;

  if (trimmed.startsWith('@')) {
    const schemaPath = trimmed.slice(1).trim();
    if (!schemaPath) {
      throw new Error('JSON schema file path after "@" cannot be empty.');
    }

    const resolvedPath = path.isAbsolute(schemaPath) ? schemaPath : path.resolve(cwd, schemaPath);
    schema = await readFile(resolvedPath);
  }

  try {
    JSON.parse(schema);
  } catch (err) {
    throw new Error(`Invalid JSON schema: ${err as Error}`);
  }

  return schema;
}

export async function resolvePromptText(
  promptText: string | undefined,
  options: { promptFile?: string; stdinIsTTY?: boolean },
  deps: PromptResolverDeps = {}
): Promise<string> {
  const readFile = deps.readFile ?? ((filePath: string) => Bun.file(filePath).text());
  const readStdin = deps.readStdin ?? (() => Bun.stdin.text());
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY;

  let resolvedPrompt: string | undefined;

  if (options.promptFile) {
    resolvedPrompt = await readFile(options.promptFile);
  } else if (!stdinIsTTY) {
    resolvedPrompt = await readStdin();
  } else if (typeof promptText === 'string') {
    resolvedPrompt = promptText;
  }

  if (!resolvedPrompt || resolvedPrompt.trim().length === 0) {
    throw new Error(
      'Prompt is required. Provide it as a positional argument, via --prompt-file, or pipe it through stdin.'
    );
  }

  return resolvedPrompt;
}

interface ClaudeArgOptions {
  prompt: string;
  model?: string;
  jsonSchema?: string;
  allowAllTools?: boolean;
}

interface CodexArgOptions {
  prompt: string;
  outputSchemaPath?: string;
  reasoningLevel?: CodexReasoningLevel;
  allowAllTools?: boolean;
  externalRepositoryConfigDir?: string;
  isUsingExternalStorage?: boolean;
}

interface RunPromptCommandDeps {
  loadEffectiveConfigFn?: typeof loadEffectiveConfig;
  runWithHeadlessAdapterIfEnabledFn?: typeof runWithHeadlessAdapterIfEnabled;
  executeClaudePromptFn?: typeof executeClaudePrompt;
  executeCodexPromptFn?: typeof executeCodexPrompt;
  stdoutWrite?: (output: string) => void;
  isTunnelActiveFn?: typeof isTunnelActive;
  stdinIsTTY?: boolean;
  envAllowAllTools?: string;
}

export function resolveClaudeModel(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }

  if (model.includes('haiku') || model.includes('sonnet') || model.includes('opus')) {
    return model;
  }

  warn(`Unrecognized Claude model "${model}". Omitting --model and using Claude CLI default.`);
  return undefined;
}

export function buildClaudeRunPromptArgs(options: ClaudeArgOptions): string[] {
  const args = [
    'claude',
    '--no-session-persistence',
    '--verbose',
    '--output-format',
    'stream-json',
  ];

  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.jsonSchema) {
    args.push('--json-schema', options.jsonSchema);
  }
  if (options.allowAllTools) {
    args.push('--dangerously-skip-permissions');
  }

  args.push('--print', options.prompt);
  return args;
}

export function buildCodexRunPromptArgs(options: CodexArgOptions): string[] {
  const reasoningLevel = options.reasoningLevel ?? 'medium';
  const sandboxSettings = options.allowAllTools
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : ['--sandbox', 'workspace-write'];

  const args = [
    'codex',
    '--enable',
    'web_search_request',
    'exec',
    '-c',
    `model_reasoning_effort=${reasoningLevel}`,
    ...sandboxSettings,
  ];

  if (
    !options.allowAllTools &&
    options.isUsingExternalStorage &&
    options.externalRepositoryConfigDir
  ) {
    const writableRoots = JSON.stringify([options.externalRepositoryConfigDir]);
    args.push('-c', `sandbox_workspace_write.writable_roots=${writableRoots}`);
  }

  if (options.outputSchemaPath) {
    args.push('--output-schema', options.outputSchemaPath);
  }

  args.push('--json', options.prompt);
  return args;
}

export function normalizeStructuredJsonOutput(value: unknown): string {
  const stripMarkdownFence = (text: string): string => {
    const trimmed = text.trim();
    const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1].trim() : trimmed;
  };

  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(stripMarkdownFence(value)) : value;
  } catch (err) {
    throw new Error(`Failed to parse structured output from executor: ${err as Error}`);
  }
  return JSON.stringify(parsed, null, 2);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

export async function executeClaudePrompt(
  prompt: string,
  options: {
    model?: string;
    jsonSchema?: string;
    allowAllTools?: boolean;
    cwd: string;
  }
): Promise<string> {
  const args = buildClaudeRunPromptArgs({
    prompt,
    model: resolveClaudeModel(options.model),
    jsonSchema: options.jsonSchema,
    allowAllTools: options.allowAllTools,
  });

  let tunnelServer: TunnelServer | undefined;
  let tunnelTempDir: string | undefined;
  let tunnelSocketPath: string | undefined;

  if (!isTunnelActive()) {
    try {
      tunnelTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-tunnel-'));
      tunnelSocketPath = path.join(tunnelTempDir, 'output.sock');
      tunnelServer = await createTunnelServer(tunnelSocketPath);
    } catch (err) {
      debugLog('Could not create tunnel server for output forwarding:', err);
    }
  }

  const tunnelEnv: Record<string, string> =
    tunnelServer && tunnelSocketPath ? { [TIM_OUTPUT_SOCKET]: tunnelSocketPath } : {};

  const split = createLineSplitter();
  let seenResultMessage = false;
  let capturedResult: string | undefined;
  let capturedStructuredOutput: unknown;
  let killedByTimeout = false;
  resetToolUseCache();

  try {
    const result = await spawnAndLogOutput(args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        TIM_EXECUTOR: 'claude',
        TIM_NOTIFY_SUPPRESS: '1',
        ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
        CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: 'true',
        ...tunnelEnv,
      },
      inactivityTimeoutMs: RUN_PROMPT_INACTIVITY_TIMEOUT_MS,
      initialInactivityTimeoutMs: RUN_PROMPT_INITIAL_INACTIVITY_TIMEOUT_MS,
      onInactivityKill: () => {
        killedByTimeout = true;
        debugLog(
          `Claude run-prompt timed out after ${Math.round(RUN_PROMPT_INACTIVITY_TIMEOUT_MS / 60000)} minutes; terminating.`
        );
      },
      formatStdout: (chunk) => {
        const lines = split(chunk);
        const formattedResults = lines.map(formatJsonMessage);
        const structuredMessages = extractStructuredMessages(formattedResults);

        for (const formatted of formattedResults) {
          if (formatted.type !== 'result') {
            continue;
          }

          seenResultMessage = true;
          if (formatted.resultText !== undefined) {
            capturedResult = formatted.resultText;
          }
          if (formatted.structuredOutput !== undefined) {
            capturedStructuredOutput = formatted.structuredOutput;
          }
        }

        return structuredMessages.length > 0 ? structuredMessages : '';
      },
    });

    if ((killedByTimeout || result.killedByInactivity) && !seenResultMessage) {
      throw new Error(
        `Claude run-prompt timed out after ${Math.round(RUN_PROMPT_INACTIVITY_TIMEOUT_MS / 60000)} minutes`
      );
    }

    if (result.exitCode !== 0 && !seenResultMessage) {
      throw new Error(`Claude exited with non-zero exit code: ${result.exitCode}`);
    }

    if (options.jsonSchema) {
      if (capturedStructuredOutput === undefined) {
        throw new Error('Claude did not return structured output.');
      }
      return normalizeStructuredJsonOutput(capturedStructuredOutput);
    }

    if (!capturedResult || capturedResult.trim().length === 0) {
      throw new Error('Claude did not return a final result.');
    }

    return capturedResult;
  } finally {
    tunnelServer?.close();
    if (tunnelTempDir) {
      await fs.rm(tunnelTempDir, { recursive: true, force: true });
    }
  }
}

export async function executeCodexPrompt(
  prompt: string,
  options: {
    jsonSchema?: string;
    reasoningLevel?: CodexReasoningLevel;
    allowAllTools?: boolean;
    cwd: string;
    externalRepositoryConfigDir?: string;
    isUsingExternalStorage?: boolean;
  }
): Promise<string> {
  let tempDir: string | undefined;
  let outputSchemaPath: string | undefined;
  let tunnelServer: TunnelServer | undefined;
  let tunnelSocketPath: string | undefined;

  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-run-prompt-'));
    if (options.jsonSchema) {
      outputSchemaPath = path.join(tempDir, 'output-schema.json');
      await fs.writeFile(outputSchemaPath, options.jsonSchema, 'utf8');
    }

    if (!isTunnelActive()) {
      try {
        tunnelSocketPath = path.join(tempDir, 'output.sock');
        tunnelServer = await createTunnelServer(tunnelSocketPath);
      } catch (err) {
        debugLog('Could not create tunnel server for output forwarding:', err);
      }
    }

    const args = buildCodexRunPromptArgs({
      prompt,
      outputSchemaPath,
      reasoningLevel: options.reasoningLevel,
      allowAllTools: options.allowAllTools,
      externalRepositoryConfigDir: options.externalRepositoryConfigDir,
      isUsingExternalStorage: options.isUsingExternalStorage,
    });

    const formatter = createCodexStdoutFormatter();
    let killedByTimeout = false;
    const result = await spawnAndLogOutput(args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        TIM_EXECUTOR: 'codex',
        AGENT: process.env.AGENT || '1',
        TIM_NOTIFY_SUPPRESS: '1',
        ...(tunnelServer && tunnelSocketPath ? { [TIM_OUTPUT_SOCKET]: tunnelSocketPath } : {}),
      },
      formatStdout: formatter.formatChunk,
      inactivityTimeoutMs: RUN_PROMPT_INACTIVITY_TIMEOUT_MS,
      initialInactivityTimeoutMs: RUN_PROMPT_INITIAL_INACTIVITY_TIMEOUT_MS,
      onInactivityKill: () => {
        killedByTimeout = true;
        debugLog(
          `Codex run-prompt timed out after ${Math.round(RUN_PROMPT_INACTIVITY_TIMEOUT_MS / 60000)} minutes; terminating.`
        );
      },
    });

    const failedMessage = formatter.getFailedAgentMessage();
    if (failedMessage) {
      warn('Codex reported a FAILED agent message; returning that message.');
      process.exitCode = 1;
    }

    const finalMessage =
      failedMessage ?? formatter.getFinalAgentResponseMessage() ?? formatter.getFinalAgentMessage();
    const timedOut = killedByTimeout || result.killedByInactivity;
    const hasFinalMessage = !!finalMessage;

    if (timedOut && !hasFinalMessage) {
      throw new Error(
        `Codex run-prompt timed out after ${Math.round(RUN_PROMPT_INACTIVITY_TIMEOUT_MS / 60000)} minutes`
      );
    }

    if (result.exitCode !== 0 && !(timedOut && hasFinalMessage)) {
      throw new Error(`Codex exited with non-zero exit code: ${result.exitCode}`);
    }

    if (!finalMessage) {
      throw new Error('No final agent message found in Codex output.');
    }

    if (options.jsonSchema) {
      return normalizeStructuredJsonOutput(finalMessage);
    }

    return finalMessage;
  } finally {
    tunnelServer?.close();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

export async function handleRunPromptCommand(
  promptText: string | undefined,
  options: RunPromptCommandOptions,
  globalCliOptions: { config?: string },
  deps: RunPromptCommandDeps = {}
): Promise<void> {
  const loadEffectiveConfigFn = deps.loadEffectiveConfigFn ?? loadEffectiveConfig;
  const runWithHeadlessAdapterIfEnabledFn =
    deps.runWithHeadlessAdapterIfEnabledFn ?? runWithHeadlessAdapterIfEnabled;
  const executeClaudePromptFn = deps.executeClaudePromptFn ?? executeClaudePrompt;
  const executeCodexPromptFn = deps.executeCodexPromptFn ?? executeCodexPrompt;
  const stdoutWrite = deps.stdoutWrite ?? ((output: string) => process.stdout.write(output));
  const isTunnelActiveFn = deps.isTunnelActiveFn ?? isTunnelActive;
  const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY;

  const config = await loadEffectiveConfigFn(globalCliOptions.config);
  const executor = resolveExecutorAlias(options.executor);
  const reasoningLevel =
    executor === 'codex' ? resolveReasoningLevel(options.reasoningLevel) : undefined;
  const schema = await resolveJsonSchemaOption(options.jsonSchema);
  const prompt = await resolvePromptText(promptText, {
    promptFile: options.promptFile,
    stdinIsTTY,
  });
  const allowAllTools = shouldAllowAllTools(deps.envAllowAllTools ?? process.env.ALLOW_ALL_TOOLS);

  const output = await runWithLogger(
    options.quiet ? runPromptQuietLogger : runPromptStderrLogger,
    () =>
      runWithHeadlessAdapterIfEnabledFn({
        enabled: !isTunnelActiveFn(),
        command: 'run-prompt',
        config,
        callback: async () => {
          if (executor === 'claude') {
            if (options.reasoningLevel) {
              warn(
                'Ignoring --reasoning-level for claude executor. This option only applies to codex.'
              );
            }
            return executeClaudePromptFn(prompt, {
              model: options.model,
              jsonSchema: schema,
              allowAllTools,
              cwd: process.cwd(),
            });
          }

          if (options.model) {
            warn('Ignoring --model for codex executor. This option only applies to claude.');
          }

          return executeCodexPromptFn(prompt, {
            jsonSchema: schema,
            reasoningLevel,
            allowAllTools,
            cwd: process.cwd(),
            externalRepositoryConfigDir: config.externalRepositoryConfigDir,
            isUsingExternalStorage: config.isUsingExternalStorage,
          });
        },
      })
  );

  stdoutWrite(ensureTrailingNewline(output));
}
