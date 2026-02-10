import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runWithLogger, warn } from '../../logging.js';
import type { LoggerAdapter } from '../../logging/adapter.js';
import { formatStructuredMessage } from '../../logging/console_formatter.js';
import type { StructuredMessage } from '../../logging/structured_messages.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { loadEffectiveConfig } from '../configLoader.js';
import type { TimConfig } from '../configSchema.js';
import { executeCodexStep } from '../executors/codex_cli/codex_runner.js';
import {
  getFixerPrompt,
  composeTesterContext,
} from '../executors/codex_cli/context_composition.js';
import { loadAgentInstructionsFor } from '../executors/codex_cli/agent_helpers.js';
import { getImplementerPrompt, getTesterPrompt } from '../executors/claude_code/agent_prompts.js';
import { getGitRoot } from '../../common/git.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { executeClaudePrompt, resolveClaudeModel, shouldAllowAllTools } from './run_prompt.js';
import { codexReasoningLevelSchema, type CodexReasoningLevel } from '../executors/schemas.js';

const execStepLogger: LoggerAdapter = {
  log: (...args: any[]) => console.error(...args),
  warn: (...args: any[]) => console.error(...args),
  error: (...args: any[]) => console.error(...args),
  writeStdout: (data: string) => process.stderr.write(data),
  writeStderr: (data: string) => process.stderr.write(data),
  debugLog: (...args: any[]) => console.error(...args),
  sendStructured: (message: StructuredMessage) => {
    const formatted = formatStructuredMessage(message);
    if (formatted.length > 0) {
      console.error(formatted);
    }
  },
};

export type ExecStepName = 'implementer' | 'tester' | 'fixer';
type ExecStepExecutor = 'claude' | 'codex';

export interface ExecStepCommandOptions {
  executor?: string;
  model?: string;
  reasoningLevel?: string;
  contextFile?: string;
  planId?: string;
  planFilePath?: string;
  instructions?: string;
  instructionsFile?: string;
  progressMode?: 'report' | 'update';
  useAtPrefix?: boolean;
  implementerOutput?: string;
  implementerOutputFile?: string;
  testerOutput?: string;
  testerOutputFile?: string;
  newlyCompletedTask?: string[];
  completedTaskTitle?: string[];
  fixInstructions?: string;
  fixInstructionsFile?: string;
  inactivityTimeoutMs?: string;
}

interface ExecStepDeps {
  loadEffectiveConfigFn?: typeof loadEffectiveConfig;
  executeClaudePromptFn?: typeof executeClaudePrompt;
  executeCodexStepFn?: typeof executeCodexStep;
  stdoutWrite?: (output: string) => void;
  isTunnelActiveFn?: typeof isTunnelActive;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function resolveExecutorAlias(input: string | undefined): ExecStepExecutor {
  const executor = (input ?? 'codex').trim().toLowerCase();
  if (executor === 'codex' || executor === 'codex-cli') {
    return 'codex';
  }
  if (executor === 'claude' || executor === 'claude-code') {
    return 'claude';
  }

  throw new Error(
    `Unsupported executor "${input}". Valid values are "codex", "codex-cli", "claude", and "claude-code".`
  );
}

function resolveReasoningLevel(value: string | undefined): CodexReasoningLevel | undefined {
  if (value == null) {
    return undefined;
  }
  return codexReasoningLevelSchema.parse(value);
}

function parseCsvArgs(input: string[] | undefined): string[] {
  return (input ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

async function readOptionalValue(inlineValue: string | undefined, filePath: string | undefined) {
  if (inlineValue && inlineValue.trim().length > 0) {
    return inlineValue;
  }

  if (!filePath) {
    return undefined;
  }

  return fs.readFile(filePath, 'utf8');
}

async function resolveContextText(
  contextText: string | undefined,
  contextFile: string | undefined
) {
  if (contextFile) {
    return (await fs.readFile(contextFile, 'utf8')).trim();
  }

  if (contextText && contextText.trim().length > 0) {
    return contextText.trim();
  }

  throw new Error(
    'Context is required. Provide it as a positional argument or via --context-file.'
  );
}

async function buildPrompt(
  step: ExecStepName,
  contextText: string | undefined,
  options: ExecStepCommandOptions,
  config: TimConfig,
  gitRoot: string
): Promise<string> {
  const instructionsFromOption = await readOptionalValue(
    options.instructions,
    options.instructionsFile
  );

  if (step === 'implementer') {
    const configInstructions = await loadAgentInstructionsFor('implementer', gitRoot, config);
    const customInstructions = [configInstructions, instructionsFromOption]
      .filter(Boolean)
      .join('\n\n');
    const context = await resolveContextText(contextText, options.contextFile);
    return getImplementerPrompt(context, options.planId, customInstructions, options.model, {
      mode: options.progressMode,
      planFilePath: options.planFilePath,
      useAtPrefix: options.useAtPrefix,
    }).prompt;
  }

  if (step === 'tester') {
    const configInstructions = await loadAgentInstructionsFor('tester', gitRoot, config);
    const customInstructions = [configInstructions, instructionsFromOption]
      .filter(Boolean)
      .join('\n\n');
    const context = await resolveContextText(contextText, options.contextFile);
    const implementerOutput = await readOptionalValue(
      options.implementerOutput,
      options.implementerOutputFile
    );
    const testerContext =
      implementerOutput && implementerOutput.trim().length > 0
        ? composeTesterContext(context, implementerOutput, parseCsvArgs(options.newlyCompletedTask))
        : context;
    return getTesterPrompt(testerContext, options.planId, customInstructions, options.model, {
      mode: options.progressMode,
      planFilePath: options.planFilePath,
      useAtPrefix: options.useAtPrefix,
    }).prompt;
  }

  const implementerOutput = await readOptionalValue(
    options.implementerOutput,
    options.implementerOutputFile
  );
  const testerOutput = await readOptionalValue(options.testerOutput, options.testerOutputFile);
  const fixInstructions = await readOptionalValue(
    options.fixInstructions,
    options.fixInstructionsFile
  );

  if (!implementerOutput || implementerOutput.trim().length === 0) {
    throw new Error('Fixer step requires --implementer-output or --implementer-output-file.');
  }
  if (!testerOutput || testerOutput.trim().length === 0) {
    throw new Error('Fixer step requires --tester-output or --tester-output-file.');
  }
  if (!fixInstructions || fixInstructions.trim().length === 0) {
    throw new Error('Fixer step requires --fix-instructions or --fix-instructions-file.');
  }

  return getFixerPrompt({
    planPath: options.planFilePath,
    planId: options.planId,
    implementerOutput,
    testerOutput,
    completedTaskTitles: parseCsvArgs(options.completedTaskTitle),
    fixInstructions,
  });
}

export async function handleExecStepCommand(
  step: ExecStepName,
  contextText: string | undefined,
  options: ExecStepCommandOptions,
  globalCliOptions: { config?: string },
  deps: ExecStepDeps = {}
): Promise<void> {
  const loadEffectiveConfigFn = deps.loadEffectiveConfigFn ?? loadEffectiveConfig;
  const executeClaudePromptFn = deps.executeClaudePromptFn ?? executeClaudePrompt;
  const executeCodexStepFn = deps.executeCodexStepFn ?? executeCodexStep;
  const stdoutWrite = deps.stdoutWrite ?? ((output: string) => process.stdout.write(output));
  const isTunnelActiveFn = deps.isTunnelActiveFn ?? isTunnelActive;

  const config = await loadEffectiveConfigFn(globalCliOptions.config);
  const gitRoot = await getGitRoot();
  const prompt = await buildPrompt(step, contextText, options, config, gitRoot);
  const executor = resolveExecutorAlias(options.executor);
  const reasoningLevel = resolveReasoningLevel(options.reasoningLevel);
  const inactivityTimeoutMs = options.inactivityTimeoutMs
    ? Number.parseInt(options.inactivityTimeoutMs, 10)
    : undefined;

  const output = await runWithLogger(execStepLogger, () =>
    runWithHeadlessAdapterIfEnabled({
      enabled: !isTunnelActiveFn(),
      command: 'exec-step',
      config,
      callback: async () => {
        if (executor === 'claude') {
          if (options.reasoningLevel) {
            warn('Ignoring --reasoning-level for claude executor.');
          }
          if (options.inactivityTimeoutMs) {
            warn('Ignoring --inactivity-timeout-ms for claude executor.');
          }

          return executeClaudePromptFn(prompt, {
            model: resolveClaudeModel(options.model),
            allowAllTools: shouldAllowAllTools(process.env.ALLOW_ALL_TOOLS),
            cwd: gitRoot,
          });
        }

        return executeCodexStepFn(prompt, gitRoot, config, {
          reasoningLevel,
          inactivityTimeoutMs,
        });
      },
    })
  );

  stdoutWrite(ensureTrailingNewline(output));
}
