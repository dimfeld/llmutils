/**
 * @fileoverview Implementation of the `tim subagent` command.
 *
 * This command runs a subagent (implementer, tester, or verifier) for the orchestrator.
 * It loads plan context, builds the appropriate agent prompt, and executes using either
 * claude-code or codex-cli. Intermediate output goes through the tunnel to the terminal,
 * while the final agent message is printed to stdout for the orchestrator to capture.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { loadEffectiveConfig } from '../configLoader.js';
import { readPlanFile, resolvePlanFile } from '../plans.js';
import { getAllIncompleteTasks } from '../plans/find_next.js';
import { buildExecutionPromptWithoutSteps } from '../prompt_builder.js';
import {
  getImplementerPrompt,
  getTesterPrompt,
  getVerifierAgentPrompt,
} from '../executors/claude_code/agent_prompts.js';
import { loadAgentInstructionsFor } from '../executors/codex_cli/agent_helpers.js';
import { executeCodexStep } from '../executors/codex_cli/codex_runner.js';
import { getGitRoot } from '../../common/git.js';
import { createLineSplitter, spawnAndLogOutput } from '../../common/process.js';
import { debugLog, error } from '../../logging.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { createTunnelServer, type TunnelServer } from '../../logging/tunnel_server.js';
import { createPromptRequestHandler } from '../../logging/tunnel_prompt_handler.js';
import { TIM_OUTPUT_SOCKET } from '../../logging/tunnel_protocol.js';
import {
  extractStructuredMessages,
  formatJsonMessage,
  resetToolUseCache,
} from '../executors/claude_code/format.js';
import { readSharedPermissions } from '../assignments/permissions_io.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { setupPermissionsMcp } from '../executors/claude_code/permissions_mcp_setup.js';
import type { TimConfig } from '../configSchema.js';
import type { Executor } from '../executors/types.js';

export type SubagentType = 'implementer' | 'tester' | 'verifier';

const DEFAULT_CLAUDE_MODEL = 'opus';

interface SubagentOptions {
  executor: string;
  model?: string;
  input?: string;
  inputFile?: string;
}

/**
 * A minimal executor-like object that satisfies the Executor interface
 * requirements for buildExecutionPromptWithoutSteps. The subagent command
 * does not need a real executor for prompt building; it only needs the
 * filePathPrefix and todoDirections properties.
 */
const minimalExecutor: Pick<Executor, 'filePathPrefix' | 'todoDirections' | 'execute'> = {
  filePathPrefix: '@',
  todoDirections: '- Use the TodoWrite tool to maintain your TODO list.',
  execute: async () => {
    throw new Error('minimalExecutor.execute should not be called');
  },
};

/**
 * Handles the `tim subagent <type> <planFile>` command.
 *
 * Loads plan context, builds the subagent prompt with the appropriate role,
 * and executes using either claude-code or codex-cli. The final agent message
 * is printed to stdout.
 */
export async function handleSubagentCommand(
  agentType: SubagentType,
  planFileArg: string,
  options: SubagentOptions,
  globalCliOptions: any
): Promise<void> {
  const config = await loadEffectiveConfig(globalCliOptions.config);
  const planFilePath = await resolvePlanFile(planFileArg, globalCliOptions.config);
  const planData = await readPlanFile(planFilePath);
  const gitRoot = await getGitRoot();
  const executorType = options.executor || 'claude-code';

  // Build the context prompt using the same pattern as batch_mode.ts
  const incompleteTasks = getAllIncompleteTasks(planData);
  const taskDescriptions = incompleteTasks
    .map((taskResult) => {
      const { taskIndex, task } = taskResult;
      let taskDescription = `Task ${taskIndex + 1}: ${task.title}`;
      if (task.description) {
        taskDescription += `\nDescription: ${task.description}`;
      }
      return taskDescription;
    })
    .join('\n\n');

  const contextContent = await buildExecutionPromptWithoutSteps({
    executor: minimalExecutor as Executor,
    planData,
    planFilePath,
    baseDir: gitRoot,
    config,
    task: {
      title: `${incompleteTasks.length} Tasks`,
      description: `Available tasks:\n\n${taskDescriptions}`,
      files: [],
    },
    filePathPrefix: '@',
    includeCurrentPlanContext: true,
    batchMode: true,
  });

  // Load custom agent instructions
  const agentInstructionsType: 'implementer' | 'tester' | 'reviewer' =
    agentType === 'verifier' ? 'tester' : agentType;
  const customInstructions = await loadAgentInstructionsFor(agentInstructionsType, gitRoot, config);

  // For verifier, also load reviewer instructions and combine them
  let combinedInstructions = customInstructions;
  if (agentType === 'verifier') {
    const reviewerInstructions = await loadAgentInstructionsFor('reviewer', gitRoot, config);
    const parts = [customInstructions, reviewerInstructions].filter((s): s is string =>
      Boolean(s?.trim())
    );
    combinedInstructions = parts.length > 0 ? parts.join('\n\n') : undefined;
  }

  const orchestratorInput = await resolveOrchestratorInput(options);

  // Combine custom instructions with orchestrator-provided input.
  const allInstructions = [combinedInstructions, orchestratorInput]
    .filter((s): s is string => Boolean(s?.trim()))
    .join('\n\n');

  const planId = planData.id?.toString() ?? 'unknown';

  // Build the agent prompt using the appropriate function
  const agentDefinition = buildAgentDefinition(
    agentType,
    contextContent,
    planId,
    allInstructions || undefined,
    options.model
  );

  // Execute using the selected executor
  let finalMessage: string;
  if (executorType === 'codex-cli') {
    if (options.model) {
      debugLog(
        'Note: --model flag is ignored for codex-cli executor (codex uses its default model)'
      );
    }
    finalMessage = await executeWithCodex(agentDefinition.prompt, gitRoot, config);
  } else {
    finalMessage = await executeWithClaude(agentDefinition.prompt, gitRoot, config, options.model);
  }

  // Print final message to stdout for orchestrator to capture
  process.stdout.write(finalMessage);
}

async function resolveOrchestratorInput(options: SubagentOptions): Promise<string | undefined> {
  if (options.input && options.inputFile) {
    throw new Error('Cannot provide both --input and --input-file. Use only one.');
  }

  if (options.input) {
    return options.input;
  }

  if (options.inputFile) {
    if (options.inputFile === '-') {
      return readStdinText(true);
    }
    return fs.readFile(options.inputFile, 'utf8');
  }

  // Fallback for piped usage: allow orchestrator to pass large context via stdin
  // without needing to write a temporary file first.
  if (!process.stdin.isTTY) {
    const stdinText = await readStdinText(false);
    if (stdinText?.trim()) {
      return stdinText;
    }
  }

  return undefined;
}

async function readStdinText(requireInput: boolean): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    if (requireInput) {
      throw new Error('--input-file - requires input on stdin.');
    }
    return undefined;
  }

  const input = await Bun.stdin.text();
  if (!input.trim()) {
    if (requireInput) {
      throw new Error('No input received on stdin.');
    }
    return undefined;
  }

  return input;
}

/**
 * Builds the agent definition (prompt) for the given subagent type.
 */
function buildAgentDefinition(
  agentType: SubagentType,
  contextContent: string,
  planId: string,
  customInstructions: string | undefined,
  model: string | undefined
) {
  switch (agentType) {
    case 'implementer':
      return getImplementerPrompt(contextContent, planId, customInstructions, model, {
        mode: 'report',
      });
    case 'tester':
      return getTesterPrompt(contextContent, planId, customInstructions, model, {
        mode: 'report',
      });
    case 'verifier':
      return getVerifierAgentPrompt(
        contextContent,
        planId,
        customInstructions,
        model,
        false,
        false,
        {
          mode: 'report',
        }
      );
  }
}

/**
 * Executes the subagent prompt using Codex CLI.
 * Follows the pattern from codex_runner.ts for tunneling setup.
 */
async function executeWithCodex(
  prompt: string,
  cwd: string,
  timConfig: TimConfig
): Promise<string> {
  return executeCodexStep(prompt, cwd, timConfig);
}

/**
 * Executes the subagent prompt using Claude Code.
 * Follows the pattern from executeReviewMode() in claude_code.ts.
 */
async function executeWithClaude(
  prompt: string,
  cwd: string,
  timConfig: TimConfig,
  model?: string
): Promise<string> {
  // Determine permissions and allowed tools setup
  const claudeCodeOptions = (timConfig.executors as Record<string, any>)?.['claude-code'] ?? {};
  const allowAllToolsValue = process.env.ALLOW_ALL_TOOLS ?? 'false';
  const allowAllTools =
    claudeCodeOptions.allowAllTools ?? ['true', '1'].includes(allowAllToolsValue.toLowerCase());

  const jsTaskRunners = ['npm', 'pnpm', 'yarn', 'bun'];
  const includeDefaultTools = claudeCodeOptions.includeDefaultTools ?? true;
  const defaultAllowedTools = includeDefaultTools
    ? [
        'Edit',
        'MultiEdit',
        'Write',
        'WebFetch',
        'WebSearch',
        'Bash(cat:*)',
        'Bash(cd:*)',
        'Bash(cp:*)',
        'Bash(find:*)',
        'Bash(grep:*)',
        'Bash(ls:*)',
        'Bash(mkdir:*)',
        'Bash(mv:*)',
        'Bash(pwd)',
        'Bash(rg:*)',
        'Bash(sed:*)',
        'Bash(awk:*)',
        'Bash(rm test-:*)',
        'Bash(rm -f test-:*)',
        'Bash(git diff:*)',
        'Bash(git status:*)',
        'Bash(git log:*)',
        'Bash(git commit:*)',
        'Bash(git add:*)',
        'Bash(jj diff:*)',
        'Bash(jj status)',
        'Bash(jj log:*)',
        'Bash(jj commit:*)',
        'Bash(jj bookmark move:*)',
        ...jsTaskRunners.flatMap((name) => [
          `Bash(${name} test:*)`,
          `Bash(${name} run build:*)`,
          `Bash(${name} run check:*)`,
          `Bash(${name} run typecheck:*)`,
          `Bash(${name} run lint:*)`,
          `Bash(${name} install)`,
          `Bash(${name} add:*)`,
        ]),
        'Bash(cargo add:*)',
        'Bash(cargo build)',
        'Bash(cargo test:*)',
        'Bash(tim add:*)',
        'Bash(tim review:*)',
        'Bash(tim set-task-done:*)',
      ]
    : [];

  // Load shared permissions
  let sharedPermissions: string[] = [];
  try {
    const identity = await getRepositoryIdentity();
    const shared = await readSharedPermissions({
      repositoryId: identity.repositoryId,
    });
    sharedPermissions = shared.permissions.allow;
  } catch {
    // Non-fatal
  }

  let allowedTools = [
    ...defaultAllowedTools,
    ...(claudeCodeOptions.allowedTools ?? []),
    ...sharedPermissions,
  ];
  if (claudeCodeOptions.disallowedTools) {
    const disallowed = claudeCodeOptions.disallowedTools;
    allowedTools = allowedTools.filter((t: string) => !disallowed.includes(t));
  }

  // Determine if permissions MCP should be enabled
  let isPermissionsMcpEnabled = claudeCodeOptions.permissionsMcp?.enabled === true;
  if (process.env.CLAUDE_CODE_MCP) {
    isPermissionsMcpEnabled = process.env.CLAUDE_CODE_MCP === 'true';
  }
  const isNoninteractive = process.env.TIM_NONINTERACTIVE === 'true';
  if (allowAllTools || isNoninteractive) {
    // permissions MCP doesn't make sense in noninteractive mode or when all tools are allowed
    isPermissionsMcpEnabled = false;
  }

  // Set up permissions MCP if enabled
  let permissionsMcpCleanup: (() => Promise<void>) | undefined;
  let permissionsMcpConfigFile: string | undefined;
  const trackedFiles = new Set<string>();

  if (isPermissionsMcpEnabled) {
    try {
      const result = await setupPermissionsMcp({
        allowedTools,
        defaultResponse: claudeCodeOptions.permissionsMcp?.defaultResponse,
        timeout: claudeCodeOptions.permissionsMcp?.timeout,
        autoApproveCreatedFileDeletion:
          claudeCodeOptions.permissionsMcp?.autoApproveCreatedFileDeletion,
        trackedFiles,
        workingDirectory: cwd,
      });
      permissionsMcpConfigFile = result.mcpConfigFile;
      permissionsMcpCleanup = result.cleanup;
    } catch (err) {
      error('Could not set up permissions MCP for subagent:', err);
      isPermissionsMcpEnabled = false;
    }
  }

  // Set up tunneling for intermediate output
  let tunnelServer: TunnelServer | undefined;
  let tunnelTempDir: string | undefined;
  let tunnelSocketPath: string | undefined;
  if (!isTunnelActive()) {
    try {
      tunnelTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-subagent-'));
      tunnelSocketPath = path.join(tunnelTempDir, 'output.sock');
      const promptHandler = createPromptRequestHandler();
      tunnelServer = await createTunnelServer(tunnelSocketPath, { onPromptRequest: promptHandler });
    } catch (err) {
      debugLog('Could not create tunnel server for subagent output forwarding:', err);
    }
  }

  try {
    const args = ['claude', '--no-session-persistence'];

    // Add MCP config: permissions MCP takes priority, then user's mcpConfigFile
    if (isPermissionsMcpEnabled && permissionsMcpConfigFile) {
      args.push('--mcp-config', permissionsMcpConfigFile);
      args.push('--permission-prompt-tool', 'mcp__permissions__approval_prompt');
    } else if (claudeCodeOptions.mcpConfigFile) {
      args.push('--mcp-config', claudeCodeOptions.mcpConfigFile);
    }

    // Add allowed tools
    if (allowedTools.length && !allowAllTools) {
      args.push('--allowedTools', allowedTools.join(','));
    }

    if (allowAllTools) {
      args.push('--dangerously-skip-permissions');
    }

    if (claudeCodeOptions.disallowedTools) {
      args.push('--disallowedTools', claudeCodeOptions.disallowedTools.join(','));
    }

    // Handle extra access directories
    if (timConfig.isUsingExternalStorage && timConfig.externalRepositoryConfigDir) {
      args.push('--add-dir', timConfig.externalRepositoryConfigDir);
    }

    // Model selection
    let modelToUse = model;
    if (
      modelToUse?.includes('haiku') ||
      modelToUse?.includes('sonnet') ||
      modelToUse?.includes('opus')
    ) {
      args.push('--model', modelToUse);
    } else {
      args.push('--model', DEFAULT_CLAUDE_MODEL);
    }

    // Use streaming JSON output for structured parsing
    args.push('--verbose', '--output-format', 'stream-json');
    args.push('--print', prompt);

    const splitter = createLineSplitter();
    let lastResultText: string | undefined;
    let lastAssistantRaw: string | undefined;
    let seenResultMessage = false;

    const timeoutMs = 30 * 60 * 1000; // 30 minutes
    let killedByTimeout = false;
    resetToolUseCache();

    const result = await spawnAndLogOutput(args, {
      env: {
        ...process.env,
        TIM_EXECUTOR: 'claude',
        TIM_NOTIFY_SUPPRESS: '1',
        ...(tunnelServer && tunnelSocketPath ? { [TIM_OUTPUT_SOCKET]: tunnelSocketPath } : {}),
        ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
        CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: 'true',
      },
      cwd,
      inactivityTimeoutMs: timeoutMs,
      initialInactivityTimeoutMs: 2 * 60 * 1000,
      onInactivityKill: () => {
        killedByTimeout = true;
        error(
          `Claude subagent timed out after ${Math.round(timeoutMs / 60000)} minutes; terminating.`
        );
      },
      formatStdout: (output) => {
        const lines = splitter(output);
        const formattedResults = lines.map(formatJsonMessage);
        const structuredMessages = extractStructuredMessages(formattedResults);

        for (const formatted of formattedResults) {
          if (formatted.type === 'result') {
            seenResultMessage = true;
            if (formatted.resultText) {
              lastResultText = formatted.resultText;
            }
          }
          if (formatted.filePaths) {
            for (const filePath of formatted.filePaths) {
              const absolutePath = path.isAbsolute(filePath)
                ? filePath
                : path.resolve(cwd, filePath);
              trackedFiles.add(absolutePath);
            }
          }
          if (formatted.type === 'assistant' && formatted.rawMessage) {
            lastAssistantRaw = formatted.rawMessage;
          }
        }

        return structuredMessages.length > 0 ? structuredMessages : '';
      },
    });

    if ((killedByTimeout || result.killedByInactivity) && !seenResultMessage) {
      throw new Error(`Claude subagent timed out after ${Math.round(timeoutMs / 60000)} minutes`);
    }

    if (result.exitCode !== 0 && !seenResultMessage) {
      throw new Error(`Claude subagent exited with non-zero exit code: ${result.exitCode}`);
    }

    // Prefer the result text from the result message, fall back to last assistant raw message
    const finalMessage = lastResultText || lastAssistantRaw;
    if (!finalMessage) {
      throw new Error('No final agent message found in Claude subagent output.');
    }

    return finalMessage;
  } finally {
    tunnelServer?.close();
    if (tunnelTempDir) {
      await fs.rm(tunnelTempDir, { recursive: true, force: true });
    }
    if (permissionsMcpCleanup) {
      await permissionsMcpCleanup();
    }
  }
}
