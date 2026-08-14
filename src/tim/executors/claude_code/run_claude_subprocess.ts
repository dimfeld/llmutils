/**
 * @fileoverview Shared infrastructure for running Claude Code as a subprocess.
 *
 * This module consolidates the common execution patterns used by both:
 * - `executeWithClaude()` in `tim subagent` command
 * - `executeReviewMode()` in `ClaudeCodeExecutor`
 *
 * It handles: allowed tools setup, permissions MCP, tunnel server,
 * CLI arg construction, subprocess spawning, stdout parsing, and cleanup.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { debugLog, error, log, sendStructured, warn } from '../../../logging.js';
import { spawnWithStreamingIO } from '../../../common/process.js';
import type { TimWorkspaceCommandEnvironmentOptions } from '../../../common/env.js';
import {
  normalizeSubprocessMonitorRules,
  startSubprocessMonitor,
  type SubprocessMonitorHandle,
} from '../../../common/subprocess_monitor.js';
import type { FormattedClaudeMessage } from './format.js';
import { createClaudeOutputStreamFormatter } from './output_stream_formatter.js';
import { executeWithTerminalInput } from './terminal_input_lifecycle.js';
import { isTunnelActive } from '../../../logging/tunnel_client.js';
import { createExecutorTunnelServer, type TunnelServer } from '../../../logging/tunnel_server.js';
import { createPromptRequestHandler } from '../../../logging/tunnel_prompt_handler.js';
import { TIM_OUTPUT_SOCKET } from '../../../logging/tunnel_protocol.js';
import { getRepositoryIdentity } from '../../assignments/workspace_identifier.js';
import { getDatabase } from '../../db/database.js';
import { getPermissions } from '../../db/permission.js';
import { getOrCreateProject } from '../../db/project.js';
import type {
  ClaudeAgentToolContext,
  ClaudePermissionPromptCoordinator,
} from './claude_mcp_protocol.js';
import {
  applyClaudeMcpLaunchArgs,
  prepareClaudeMcpLaunch,
  type ClaudeMcpLaunchResult,
} from './claude_mcp_launch.js';
export {
  getAgentToolIds,
  resolveClaudeMcpCapabilities,
  validateAgentToolDisallowConflict,
} from './claude_mcp_launch.js';
export type { ClaudeMcpCapabilities } from './claude_mcp_launch.js';
import type { TimConfig } from '../../configSchema.js';
import type {
  ClaudePersistentAgentCompletion,
  ClaudePersistentAgentLaunchHandle,
  ClaudePersistentAgentMode,
} from './persistent_agent_contract.js';
export {
  CLAUDE_PERSISTENT_AGENT_MODE,
  CLAUDE_PERSISTENT_AGENT_STATES,
  isClaudePersistentAgentMode,
  isClaudePersistentAgentState,
  validateClaudePersistentAgentLaunchHandle,
} from './persistent_agent_contract.js';
export type {
  ClaudePersistentAgentCompletion,
  ClaudePersistentAgentLaunchHandle,
  ClaudePersistentAgentMode,
  ClaudePersistentAgentState,
} from './persistent_agent_contract.js';

const DEFAULT_CLAUDE_MODEL = 'opus';

const JS_TASK_RUNNERS = ['npm', 'pnpm', 'yarn', 'bun'];

/**
 * Returns the canonical default allowed tools list for Claude Code subprocesses.
 * This is the single source of truth, eliminating duplication across callers.
 */
export function getDefaultAllowedTools(): string[] {
  return [
    'Read',
    'Edit',
    'MultiEdit',
    'Write',
    'Glob',
    'Grep',
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
    ...JS_TASK_RUNNERS.flatMap((name) => [
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
    'Bash(tim subagent:*)',
    'Bash(tim tools update-plan-tasks:*)',
  ];
}

/**
 * Builds the final allowed tools list by merging defaults, config additions,
 * shared permissions, and filtering out disallowed tools.
 */
export function buildAllowedToolsList(options: {
  includeDefaultTools?: boolean;
  configAllowedTools?: string[];
  extraAllowedTools?: string[];
  disallowedTools?: string[];
  sharedPermissions?: string[];
}): string[] {
  const defaultTools = (options.includeDefaultTools ?? true) ? getDefaultAllowedTools() : [];
  let tools = [
    ...defaultTools,
    ...(options.configAllowedTools ?? []),
    ...(options.extraAllowedTools ?? []),
    ...(options.sharedPermissions ?? []),
  ];
  if (options.disallowedTools) {
    const disallowed = options.disallowedTools;
    tools = tools.filter((t) => !disallowed.includes(t));
  }
  return tools;
}

export interface ClaudeCodeSubprocessOptions {
  /** Allow all tools without permission prompts (e.g., from config or env) */
  allowAllTools?: boolean;
  /** Whether to include the default allowed tools list */
  includeDefaultTools?: boolean;
  /** Extra tools to allow beyond the defaults */
  allowedTools?: string[];
  /** Additional tools requested by the caller for this execution only */
  extraAllowedTools?: string[];
  /** Tools to remove from the allowed list */
  disallowedTools?: string[];
  /** Path to an MCP config file to pass to Claude */
  mcpConfigFile?: string;
  /** Reasoning effort to pass to Claude via --effort */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Permissions MCP configuration */
  permissionsMcp?: {
    enabled?: boolean;
    defaultResponse?: 'yes' | 'no';
    timeout?: number;
    autoApproveCreatedFileDeletion?: boolean;
  };
  /** Trusted parent-bound Claude agent tools for this execution. */
  agentToolContext?: ClaudeAgentToolContext;
  /** Root-owned coordinator for interactive permission requests. */
  permissionPromptCoordinator?: ClaudePermissionPromptCoordinator;
}

export interface RunClaudeSubprocessOptions {
  /** Existing one-shot behavior. Omitted means one-shot for compatibility. */
  mode?: 'one-shot';

  /** The prompt to send to Claude */
  prompt: string;

  /** Working directory for the subprocess */
  cwd: string;

  /** Claude Code executor options */
  claudeCodeOptions: ClaudeCodeSubprocessOptions;

  /** Effective tim configuration for subprocess monitoring and related runtime behavior. */
  timConfig?: TimConfig;

  /** Project environment rendering options for the subprocess. */
  timEnvironment?: TimWorkspaceCommandEnvironmentOptions;

  /** Whether the caller is running in non-interactive mode */
  noninteractive: boolean;

  /** Whether to enable live terminal input forwarding to the subprocess */
  terminalInput?: boolean;

  /** Model to use (e.g., 'opus', 'sonnet') */
  model?: string;

  /** Label used in error/timeout messages (e.g., 'subagent', 'review') */
  label: string;

  /** Inactivity timeout in milliseconds. Defaults to 30 * 60 * 1000 (30 min). */
  inactivityTimeoutMs?: number;

  /** Initial inactivity timeout in ms. Defaults to 2 * 60 * 1000 (2 min). */
  initialInactivityTimeoutMs?: number;

  /**
   * Additional CLI args to pass to the claude subprocess.
   * For example, ['--json-schema', schemaString] for review mode.
   */
  extraArgs?: string[];

  /**
   * Additional access directories to pass via --add-dir.
   */
  extraAccessDirs?: string[];

  /**
   * Tracked files set for permissions MCP auto-approval of created file deletion.
   * If not provided, a fresh Set is created internally.
   */
  trackedFiles?: Set<string>;

  /**
   * Callback to process each batch of formatted stdout messages.
   * Called with the array of FormattedClaudeMessage from each stdout chunk.
   * Callers use this to extract their specific output data.
   */
  processFormattedMessages: (messages: FormattedClaudeMessage[]) => void;

  /** Whether to log model selection. Defaults to false. */
  logModelSelection?: boolean;
}

/**
 * Explicit persistent-agent options. This is kept separate from
 * RunClaudeSubprocessOptions so existing one-shot callers do not receive a
 * persistent-handle union as the runner is migrated in a later task.
 */
export interface ClaudePersistentAgentRunOptions extends Omit<RunClaudeSubprocessOptions, 'mode'> {
  readonly mode: ClaudePersistentAgentMode;
  /** Provider output activity callback consumed by the lifecycle owner. */
  readonly onOutputActivity?: () => void;
}

/** The complete Claude option surface used by the future provider launcher. */
export type ClaudeSubprocessExecutionOptions =
  | RunClaudeSubprocessOptions
  | ClaudePersistentAgentRunOptions;

/** The result type returned by the future persistent launch branch. */
export type ClaudePersistentAgentLaunchResult = ClaudePersistentAgentLaunchHandle;

/** The completion type used by a persistent Claude provider. */
export type ClaudePersistentAgentCompletionResult = ClaudePersistentAgentCompletion;

export interface RunClaudeSubprocessResult {
  /** Whether a successful result message was accepted as final completion. */
  acceptedFinalResult: boolean;
  /** Whether the process was killed by timeout */
  killedByTimeout: boolean;
  /** The exit code of the subprocess */
  exitCode: number;
  /** Whether killed by inactivity (from spawnWithStreamingIO) */
  killedByInactivity: boolean;
}

/**
 * Loads shared permissions from cross-worktree storage.
 */
async function loadSharedPermissions(): Promise<string[]> {
  try {
    const identity = await getRepositoryIdentity();
    const db = getDatabase();
    const project = getOrCreateProject(db, identity.repositoryId, {
      remoteUrl: identity.remoteUrl,
    });
    return getPermissions(db, project.id).allow;
  } catch (err) {
    debugLog('Could not load shared permissions:', err);
    return [];
  }
}

/**
 * Runs a Claude Code subprocess with the standard setup pattern:
 * permissions MCP, tunnel server, CLI args, streaming stdout parsing, and cleanup.
 */
export async function runClaudeSubprocess(
  options: RunClaudeSubprocessOptions
): Promise<RunClaudeSubprocessResult> {
  const {
    prompt,
    cwd,
    claudeCodeOptions,
    noninteractive,
    terminalInput,
    model,
    label,
    extraArgs,
    extraAccessDirs,
    processFormattedMessages,
    logModelSelection,
  } = options;

  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? 30 * 60 * 1000;
  const initialInactivityTimeoutMs = options.initialInactivityTimeoutMs ?? 2 * 60 * 1000;
  const trackedFiles = options.trackedFiles ?? new Set<string>();

  // Validate subprocess monitor rules up front, before any resource allocation,
  // so a bad regex fails cleanly without leaking permissions MCP or tunnel resources.
  const subprocessMonitorRules = options.timConfig?.subprocessMonitor?.rules;
  if (subprocessMonitorRules?.length) {
    normalizeSubprocessMonitorRules(subprocessMonitorRules);
  }

  // Resolve allowAllTools
  let allowAllTools = claudeCodeOptions.allowAllTools;
  if (allowAllTools == null) {
    const allowAllToolsValue = process.env.ALLOW_ALL_TOOLS ?? 'false';
    allowAllTools = ['true', '1'].includes(allowAllToolsValue.toLowerCase());
  }

  // Load shared permissions and build final tools list
  const sharedPermissions = await loadSharedPermissions();
  const baseAllowedTools = buildAllowedToolsList({
    includeDefaultTools: claudeCodeOptions.includeDefaultTools,
    configAllowedTools: claudeCodeOptions.allowedTools,
    extraAllowedTools: claudeCodeOptions.extraAllowedTools,
    disallowedTools: claudeCodeOptions.disallowedTools,
    sharedPermissions,
  });

  // Approval prompting and trusted agent tools are independent capabilities.
  let interactiveApprovalEnabled = claudeCodeOptions.permissionsMcp?.enabled === true;
  if (process.env.CLAUDE_CODE_MCP) {
    interactiveApprovalEnabled = process.env.CLAUDE_CODE_MCP === 'true';
  }
  const agentToolContext = claudeCodeOptions.agentToolContext;
  let mcpLaunch: ClaudeMcpLaunchResult;
  try {
    mcpLaunch = await prepareClaudeMcpLaunch({
      cwd,
      allowedTools: baseAllowedTools,
      mcpConfigFile: claudeCodeOptions.mcpConfigFile,
      interactiveApprovalRequested: interactiveApprovalEnabled,
      allowAllTools,
      noninteractive,
      disallowedTools: claudeCodeOptions.disallowedTools,
      permissionsMcp: claudeCodeOptions.permissionsMcp,
      trackedFiles,
      agentToolContext,
      permissionPromptCoordinator: claudeCodeOptions.permissionPromptCoordinator,
    });
  } catch (err) {
    if (agentToolContext !== undefined || claudeCodeOptions.mcpConfigFile !== undefined) throw err;
    error(`Could not set up permissions MCP for ${label}:`, err);
    mcpLaunch = {
      capabilities: {
        interactiveApprovalEnabled: false,
        agentToolsEnabled: false,
        internalMcpNeeded: false,
        agentToolIds: [],
      },
      allowedTools: baseAllowedTools,
    };
  }
  const { capabilities } = mcpLaunch;
  interactiveApprovalEnabled = capabilities.interactiveApprovalEnabled;
  const allowedTools = mcpLaunch.allowedTools;
  const permissionsMcpCleanup = mcpLaunch.cleanup;
  const permissionsMcpTempDir = mcpLaunch.tempDir;

  // Set up tunneling for intermediate output
  let tunnelServer: TunnelServer | undefined;
  // Reuse permissions MCP temp dir if available, otherwise create a new one
  const tunnelTempDir =
    permissionsMcpTempDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), `tim-${label}-`)));
  const tunnelSocketPath = path.join(tunnelTempDir, 'output.sock');
  if (!isTunnelActive()) {
    try {
      const promptHandler = createPromptRequestHandler();
      tunnelServer = await createExecutorTunnelServer(tunnelSocketPath, {
        onPromptRequest: promptHandler,
      });
    } catch (err) {
      debugLog(`Could not create tunnel server for ${label} output forwarding:`, err);
    }
  }

  let acceptedFinalResult = false;
  let killedByTimeout = false;
  let terminalInputResult: ReturnType<typeof executeWithTerminalInput> | undefined;
  let monitorHandle: SubprocessMonitorHandle | undefined;

  try {
    const args = ['claude', '--no-session-persistence', '--permission-mode', 'auto'];

    applyClaudeMcpLaunchArgs(args, mcpLaunch, claudeCodeOptions.mcpConfigFile);

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

    // Extra access directories
    if (extraAccessDirs) {
      for (const dir of extraAccessDirs) {
        args.push('--add-dir', dir);
      }
    }

    // Model selection
    let modelToUse = model;
    if (
      modelToUse?.includes('haiku') ||
      modelToUse?.includes('sonnet') ||
      modelToUse?.includes('opus') ||
      modelToUse?.includes('fable')
    ) {
      if (logModelSelection) {
        log(`Using model: ${modelToUse}\n`);
      }
      args.push('--model', modelToUse);
    } else {
      if (logModelSelection) {
        log(`Using default model: ${DEFAULT_CLAUDE_MODEL}\n`);
      }
      args.push('--model', DEFAULT_CLAUDE_MODEL);
    }

    if (claudeCodeOptions.reasoningEffort) {
      args.push('--effort', claudeCodeOptions.reasoningEffort);
    }

    // Streaming JSON I/O
    args.push('--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json');

    // Extra args (e.g., --json-schema for review mode)
    if (extraArgs) {
      args.push(...extraArgs);
    }

    const streamFormatter = createClaudeOutputStreamFormatter(modelToUse);

    if (logModelSelection) {
      log(`Interactive permissions MCP is`, interactiveApprovalEnabled ? 'enabled' : 'disabled');
    }

    const streaming = await spawnWithStreamingIO(args, {
      sessionProcessLabel: `Claude ${label}`,
      sessionProcessControl: 'both',
      onSessionProcessReady: (lifecycle) => {
        lifecycle.setGracefulEndHandler(() => terminalInputResult?.endSession?.());
      },
      env: {
        CLAUDECODE: '',
        TIM_EXECUTOR: 'claude',
        TIM_NOTIFY_SUPPRESS: '1',
        TMPDIR: '/tmp/claude/',
        ...(tunnelServer && tunnelSocketPath ? { [TIM_OUTPUT_SOCKET]: tunnelSocketPath } : {}),
        ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
        CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: 'true',
      },
      timEnvironment: options.timEnvironment,
      cwd,
      inactivityTimeoutMs,
      initialInactivityTimeoutMs,
      onInactivityKill: () => {
        killedByTimeout = true;
        error(
          `Claude ${label} timed out after ${Math.round(inactivityTimeoutMs / 60000)} minutes; terminating.`
        );
      },
      formatStdout: (output) => {
        const { formattedResults, structuredMessages } = streamFormatter.formatChunk(output);

        // Track result messages and file paths
        for (const formatted of formattedResults) {
          terminalInputResult?.observeFormattedMessage(formatted);

          if (formatted.type === 'result') {
            terminalInputResult?.onResultMessage(formatted.resultInfo?.success !== false);
          }
          if (formatted.filePaths) {
            for (const filePath of formatted.filePaths) {
              const absolutePath = path.isAbsolute(filePath)
                ? filePath
                : path.resolve(cwd, filePath);
              trackedFiles.add(absolutePath);
            }
          }
        }

        // Let the caller extract mode-specific data
        processFormattedMessages(formattedResults);

        return structuredMessages.length > 0 ? structuredMessages : '';
      },
    });

    if (subprocessMonitorRules?.length) {
      monitorHandle = startSubprocessMonitor({
        rootPid: streaming.pid,
        rules: subprocessMonitorRules,
        pollIntervalSeconds: options.timConfig?.subprocessMonitor?.pollIntervalSeconds,
        logger: { warn },
      });
    }

    terminalInputResult = executeWithTerminalInput({
      streaming,
      prompt,
      sendStructured,
      debugLog,
      errorLog: error,
      log,
      label,
      tunnelServer,
      terminalInputEnabled: terminalInput === true,
      tunnelForwardingEnabled: isTunnelActive(),
    });

    const result = await terminalInputResult.resultPromise;
    acceptedFinalResult = terminalInputResult.acceptedSuccessfulFinalResult();

    return {
      acceptedFinalResult,
      killedByTimeout,
      exitCode: result.exitCode,
      killedByInactivity: result.killedByInactivity ?? false,
    };
  } finally {
    monitorHandle?.stop();
    terminalInputResult?.cleanup();
    tunnelServer?.close();
    // Clean up tunnel temp dir if we created a separate one (not reusing permissions MCP dir)
    if (!permissionsMcpTempDir) {
      await fs.rm(tunnelTempDir, { recursive: true, force: true });
    }
    if (permissionsMcpCleanup) {
      await permissionsMcpCleanup();
    }
  }
}
