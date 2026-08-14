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
import { spawnWithStreamingIO, type StreamingProcess } from '../../../common/process.js';
import {
  getCurrentSessionProcessOwner,
  type SessionExecutorLifecycle,
} from '../../../common/session_process_control.js';
import type { TimWorkspaceCommandEnvironmentOptions } from '../../../common/env.js';
import {
  normalizeSubprocessMonitorRules,
  startSubprocessMonitor,
  type SubprocessMonitorHandle,
} from '../../../common/subprocess_monitor.js';
import type { FormattedClaudeMessage } from './format.js';
import { createClaudeOutputStreamFormatter } from './output_stream_formatter.js';
import { executeWithTerminalInput } from './terminal_input_lifecycle.js';
import { safeEndStdin } from './streaming_input.js';
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
import type { TimConfig } from '../../configSchema.js';
import type {
  AgentProviderControlResult,
  AgentProviderLifecycleControls,
  AgentProviderLifecycleObserver,
  ProcessControlId,
} from '../../agent_messaging/agent_manager_types.js';
import {
  AgentProviderControlError,
  AgentProviderForceNotAcceptedError,
} from '../../agent_messaging/agent_manager_types.js';
import type { AgentProcessLabel } from '../../agent_messaging/agent_process_labels.js';
import type { StructuredMessage } from '../../../logging/structured_messages.js';
import type {
  ClaudePersistentAgentCompletion,
  ClaudePersistentAgentLaunchHandle,
  ClaudePersistentAgentMode,
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

  /**
   * Optional Claude executable path used by local stream-json integration
   * tests. Production callers leave this unset and continue to run `claude`.
   */
  claudeExecutable?: string;
}

/**
 * Explicit persistent-agent options. This is kept separate from
 * RunClaudeSubprocessOptions so existing one-shot callers do not receive a
 * persistent-handle union as the runner is migrated in a later task.
 */
export interface ClaudePersistentAgentRunOptions extends Omit<RunClaudeSubprocessOptions, 'mode'> {
  readonly mode: ClaudePersistentAgentMode;
  /** Provider output activity callback consumed by the lifecycle owner. */
  readonly onOutputActivity?: () => void | Promise<void>;
  /** Optional named process-tree label supplied by AgentManager. */
  readonly processLabel?: AgentProcessLabel;
  /** Optional short drain grace used by deterministic local integration tests. */
  readonly persistentTurnGraceMs?: number;
}

/** The complete Claude option surface used by the future provider launcher. */
export type ClaudeSubprocessExecutionOptions =
  | RunClaudeSubprocessOptions
  | ClaudePersistentAgentRunOptions;

/** The result type returned by the future persistent launch branch. */
export type ClaudePersistentAgentLaunchResult = ClaudePersistentAgentLaunchHandle;

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
export function runClaudeSubprocess(
  options: RunClaudeSubprocessOptions
): Promise<RunClaudeSubprocessResult>;
export function runClaudeSubprocess(
  options: ClaudePersistentAgentRunOptions
): Promise<ClaudePersistentAgentLaunchResult>;
export async function runClaudeSubprocess(
  options: ClaudeSubprocessExecutionOptions
): Promise<RunClaudeSubprocessResult | ClaudePersistentAgentLaunchResult> {
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
  const persistentAgent = options.mode === 'persistent-agent';

  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? 30 * 60 * 1000;
  const initialInactivityTimeoutMs = options.initialInactivityTimeoutMs ?? 2 * 60 * 1000;
  const trackedFiles = options.trackedFiles ?? new Set<string>();
  // Capture the owner that created this exact executor before any asynchronous
  // setup. Force control must use this owner and the lifecycle's opaque
  // process ID; it must never fall back to the child PID or display label.
  const sessionProcessOwner = persistentAgent ? getCurrentSessionProcessOwner() : undefined;

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
  let acceptedFinalResult = false;
  let killedByTimeout = false;
  let terminalInputResult: ReturnType<typeof executeWithTerminalInput> | undefined;
  let monitorHandle: SubprocessMonitorHandle | undefined;
  let streaming: StreamingProcess | undefined;
  let tunnelServer: TunnelServer | undefined;
  let tunnelTempDir: string | undefined;
  let sessionProcessLifecycle: SessionExecutorLifecycle | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let cleanupStarted = false;

  const cleanup = async (): Promise<void> => {
    if (cleanupPromise === undefined) {
      cleanupStarted = true;
    }
    cleanupPromise ??= (async (): Promise<void> => {
      let firstError: unknown;

      try {
        // Close the input/controller first. This sets the provider state to
        // closing and rejects late tunnel, headless, mailbox, and formatter
        // writes before any other execution resource is torn down.
        terminalInputResult?.cleanup();
      } catch (error) {
        firstError ??= error;
      }

      try {
        sessionProcessLifecycle?.setGracefulEndHandler(undefined);
      } catch (error) {
        firstError ??= error;
      }

      try {
        monitorHandle?.stop();
      } catch (error) {
        firstError ??= error;
      }

      try {
        tunnelServer?.close();
      } catch (error) {
        firstError ??= error;
      }

      if (!permissionsMcpTempDir && tunnelTempDir !== undefined) {
        try {
          await fs.rm(tunnelTempDir, { recursive: true, force: true });
        } catch (error) {
          firstError ??= error;
        }
      }

      try {
        await permissionsMcpCleanup?.();
      } catch (error) {
        firstError ??= error;
      }

      if (firstError !== undefined) throw firstError;
    })();
    return cleanupPromise;
  };

  const completionDeferred = persistentAgent
    ? createDeferred<ClaudePersistentAgentCompletion>()
    : undefined;
  const lifecycleObservers = new Set<AgentProviderLifecycleObserver>();
  let persistentController: ReturnType<typeof executeWithTerminalInput>['persistentAgent'];
  let completionFinalized = false;
  let exitNotified = false;
  let settledResultText: string | undefined;
  let lastCompletedAssistantMessage: string | undefined;
  let lastSessionEndMessage: StructuredMessage | undefined;
  let closeAfterTurnRequested = false;
  let gracefulShutdownAccepted = false;
  let gracefulShutdownRequest: Promise<AgentProviderControlResult> | undefined;
  let forcedShutdownAccepted = false;
  let forcedShutdownRequest: Promise<AgentProviderControlResult> | undefined;
  const notifyOutputActivity = (): void => {
    if (!persistentAgent) return;
    try {
      const result = options.onOutputActivity?.();
      void Promise.resolve(result).catch((error: unknown) => {
        debugLog(`Claude ${label} output activity callback failed:`, error);
      });
    } catch (error) {
      debugLog(`Claude ${label} output activity callback failed:`, error);
    }
    for (const observer of lifecycleObservers) {
      try {
        observer.outputActivity();
      } catch (error) {
        debugLog(`Claude ${label} lifecycle output callback failed:`, error);
      }
    }
  };

  const notifyCompletedAssistantMessage = (message: string): void => {
    if (!persistentAgent) return;
    lastCompletedAssistantMessage = message;
    for (const observer of lifecycleObservers) {
      try {
        observer.completedAssistantMessage(message);
      } catch (error) {
        debugLog(`Claude ${label} lifecycle assistant callback failed:`, error);
      }
    }
  };

  const notifyTurnComplete = (
    successful: boolean,
    generation: number,
    resultText: string | undefined
  ): void => {
    if (!persistentAgent) return;
    settledResultText = resultText;
    for (const observer of lifecycleObservers) {
      try {
        observer.turnComplete();
      } catch (error) {
        debugLog(`Claude ${label} lifecycle turn callback failed:`, error);
      }
    }
    debugLog(
      `Claude ${label} persistent turn ${generation} settled (${successful ? 'success' : 'failure'})`
    );
  };

  const notifyExit = (
    classification: 'natural' | 'graceful' | 'forced' | 'failed',
    error?: Error
  ) => {
    if (exitNotified) return;
    exitNotified = true;
    for (const observer of lifecycleObservers) {
      try {
        observer.exit(classification, error);
      } catch (observerError) {
        debugLog(`Claude ${label} lifecycle exit callback failed:`, observerError);
      }
    }
  };

  const lifecycle: AgentProviderLifecycleControls = {
    requestGracefulShutdown: (instruction: string): Promise<AgentProviderControlResult> => {
      if (gracefulShutdownRequest !== undefined) return gracefulShutdownRequest;
      if (completionFinalized || persistentController === undefined) {
        return Promise.resolve('already-exited');
      }

      gracefulShutdownRequest = (async (): Promise<AgentProviderControlResult> => {
        try {
          const delivery = await Promise.resolve(persistentController!.sendContent(instruction));
          if (delivery === 'temporarily-unavailable') {
            throw new AgentProviderControlError(
              'graceful-shutdown',
              'Claude persistent input is temporarily unavailable for graceful shutdown'
            );
          }

          // The writer has accepted the shutdown instruction. Close only after
          // the turn that contains it settles. If the result callback already
          // moved the controller to idle while the write was resolving, that
          // result is already settled and closing the input is safe.
          closeAfterTurnRequested = true;
          if (persistentController!.state === 'idle') {
            persistentController!.forceCloseInputNow();
          } else {
            persistentController!.requestCloseAfterCurrentResult('graceful');
          }
          gracefulShutdownAccepted = true;
          return 'accepted';
        } catch (error) {
          if (persistentController?.state === 'exited' || completionFinalized) {
            return 'already-exited';
          }
          if (error instanceof AgentProviderControlError) throw error;
          throw new AgentProviderControlError(
            'graceful-shutdown',
            `Claude persistent graceful shutdown failed: ${String(error)}`,
            { cause: error }
          );
        }
      })();
      return gracefulShutdownRequest;
    },
    requestCloseAfterCurrentTurn: async (): Promise<AgentProviderControlResult> => {
      if (completionFinalized || persistentController === undefined) return 'already-exited';
      if (closeAfterTurnRequested) return 'accepted';
      if (
        persistentController.state === 'exited' ||
        persistentController.state === 'failed' ||
        persistentController.state === 'closing'
      ) {
        return persistentController.state === 'closing' ? 'accepted' : 'already-exited';
      }
      closeAfterTurnRequested = true;
      try {
        // AgentLifecycleController receives turnComplete after the provider
        // controller has settled to idle. In that case the current result is
        // already complete, so close the shared input now. Active and
        // background-pending turns keep the controller's result boundary.
        if (persistentController.state === 'idle') {
          if (persistentController.generation === 0) {
            closeAfterTurnRequested = false;
            throw new AgentProviderControlError(
              'close-after-current-turn',
              'Claude persistent agent has no current turn to close'
            );
          }
          persistentController.forceCloseInputNow();
        } else {
          persistentController.requestCloseAfterCurrentResult();
        }
        return 'accepted';
      } catch (error) {
        const stateAfterError = persistentController.state as string;
        if (stateAfterError === 'exited' || stateAfterError === 'failed') {
          return 'already-exited';
        }
        if (error instanceof AgentProviderControlError) throw error;
        throw new AgentProviderControlError(
          'close-after-current-turn',
          `Claude persistent close-after-turn failed: ${String(error)}`,
          { cause: error }
        );
      }
    },
    requestForcedShutdown: (): Promise<AgentProviderControlResult> => {
      if (forcedShutdownRequest !== undefined) return forcedShutdownRequest;
      if (completionFinalized || persistentController === undefined) {
        return Promise.resolve('already-exited');
      }
      if (persistentController.state === 'exited') return Promise.resolve('already-exited');
      if (forcedShutdownAccepted) return Promise.resolve('accepted');

      forcedShutdownRequest = (async (): Promise<AgentProviderControlResult> => {
        const processLifecycle = sessionProcessLifecycle;
        if (sessionProcessOwner === undefined || processLifecycle === undefined) {
          throw new AgentProviderForceNotAcceptedError(
            'Claude persistent forced shutdown has no captured safe process capability'
          );
        }

        let result: ReturnType<typeof sessionProcessOwner.terminateExecutor>;
        try {
          result = sessionProcessOwner.terminateExecutor(processLifecycle.processId);
        } catch (error) {
          throw new AgentProviderForceNotAcceptedError(
            `Claude persistent forced shutdown failed before acceptance: ${String(error)}`,
            { cause: error }
          );
        }

        switch (result) {
          case 'terminated':
          case 'requested':
            forcedShutdownAccepted = true;
            return 'accepted';
          case 'already_exited':
            return 'already-exited';
          default:
            throw new AgentProviderForceNotAcceptedError(
              `Claude persistent forced shutdown was not accepted by the safe process owner (${result})`
            );
        }
      })();

      forcedShutdownRequest = forcedShutdownRequest.catch((error: unknown) => {
        // A typed failure proves that no force was accepted. Keep the
        // operation retryable. Other failures are intentionally retained by
        // the already-set promise so callers cannot issue an unsafe retry.
        if (error instanceof AgentProviderForceNotAcceptedError) {
          forcedShutdownRequest = undefined;
        }
        throw error;
      });
      return forcedShutdownRequest;
    },
    subscribe: (observer: AgentProviderLifecycleObserver): (() => void) => {
      lifecycleObservers.add(observer);
      return (): void => {
        lifecycleObservers.delete(observer);
      };
    },
  };

  try {
    // Reuse the permissions MCP temp dir if available, otherwise create a
    // separate output tunnel directory. This is inside the guarded setup so a
    // failure here still releases a successfully-created MCP bridge.
    tunnelTempDir =
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

    const args = [
      options.claudeExecutable ?? 'claude',
      '--no-session-persistence',
      '--permission-mode',
      'auto',
    ];

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

    if (logModelSelection) {
      log(`Interactive permissions MCP is`, interactiveApprovalEnabled ? 'enabled' : 'disabled');
    }

    const sessionProcessLabel =
      persistentAgent && options.processLabel !== undefined
        ? options.processLabel
        : `Claude ${label}`;
    const streamFormatter = createClaudeOutputStreamFormatter(modelToUse);

    streaming = await spawnWithStreamingIO(args, {
      sessionProcessLabel,
      sessionProcessControl: 'both',
      onSessionProcessReady: (lifecycle) => {
        sessionProcessLifecycle = lifecycle;
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
      disableInactivityKill: persistentAgent,
      onInactivityKill: () => {
        killedByTimeout = true;
        error(
          `Claude ${label} timed out after ${Math.round(inactivityTimeoutMs / 60000)} minutes; terminating.`
        );
      },
      onOutputActivity: persistentAgent ? notifyOutputActivity : undefined,
      ...(persistentAgent ? { captureStdout: false, captureStderr: false } : {}),
      formatStdout: (output) => {
        if (cleanupStarted) return '';
        const { formattedResults, structuredMessages } = streamFormatter.formatChunk(output);

        // Track complete lifecycle messages and file paths for this execution.
        for (const formatted of formattedResults) {
          if (formatted.structured !== undefined) {
            const structured = Array.isArray(formatted.structured)
              ? formatted.structured
              : [formatted.structured];
            for (const message of structured) {
              if (message.type === 'agent_session_end') {
                lastSessionEndMessage = message;
              }
            }
          }

          if (terminalInputResult !== undefined) {
            terminalInputResult.observeFormattedMessage(formatted);
          }

          if (formatted.type === 'result') {
            terminalInputResult?.onResultMessage(
              formatted.resultInfo?.success !== false,
              formatted.resultText
            );
          }
          if (persistentAgent && formatted.type === 'assistant' && formatted.rawMessage?.trim()) {
            notifyCompletedAssistantMessage(formatted.rawMessage);
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

        if (!persistentAgent) return structuredMessages.length > 0 ? structuredMessages : '';
        return structuredMessages.filter((message) => message.type !== 'agent_session_end');
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
      persistentAgent: persistentAgent
        ? {
            initialPrompt: prompt,
            onTurnComplete: notifyTurnComplete,
            ...(options.persistentTurnGraceMs === undefined
              ? {}
              : { graceMs: options.persistentTurnGraceMs }),
          }
        : undefined,
    });

    persistentController = terminalInputResult.persistentAgent;
    if (persistentAgent && persistentController === undefined) {
      throw new Error('Persistent Claude runner did not create its input controller');
    }

    if (persistentAgent) {
      const readyController = persistentController;
      if (readyController === undefined) {
        throw new Error('Persistent Claude runner lost its input controller');
      }
      const readyCompletionDeferred = completionDeferred;
      if (readyCompletionDeferred === undefined) {
        throw new Error('Persistent Claude runner completion was not initialized');
      }
      const completion = readyCompletionDeferred.promise;

      const processCompletion = terminalInputResult.resultPromise;
      void (async (): Promise<void> => {
        let processResult: Awaited<typeof processCompletion> | undefined;
        let processError: Error | undefined;
        try {
          processResult = await processCompletion;
          if (persistentController?.state === 'failed') {
            processError = toError(
              persistentController.inputWriter.lastError ??
                new Error(`Claude ${label} persistent input failed`)
            );
          }
        } catch (error) {
          processError = toError(error);
        }

        let cleanupError: Error | undefined;
        try {
          await cleanup();
        } catch (error) {
          cleanupError = toError(error);
          debugLog(`Claude ${label} persistent cleanup failed:`, cleanupError);
        }

        if (processError !== undefined) {
          persistentController?.markProviderFailed(processError);
        } else {
          persistentController?.markProviderExited();
        }

        if (lastSessionEndMessage !== undefined) {
          try {
            sendStructured(lastSessionEndMessage);
          } catch (error) {
            debugLog(`Claude ${label} final session message failed:`, error);
          }
        }

        const exitError =
          processError ??
          cleanupError ??
          (processResult !== undefined && processResult.exitCode !== 0
            ? new Error(`Claude ${label} exited with code ${processResult.exitCode}`)
            : undefined);
        const classification = forcedShutdownAccepted
          ? 'forced'
          : exitError === undefined
            ? closeAfterTurnRequested || gracefulShutdownAccepted
              ? 'graceful'
              : 'natural'
            : 'failed';
        notifyExit(classification, exitError);
        lifecycleObservers.clear();
        if (!completionFinalized) {
          completionFinalized = true;
          readyCompletionDeferred.resolve(
            Object.freeze({
              ...(exitError === undefined ? {} : { error: exitError }),
              ...(processResult?.exitCode === undefined
                ? {}
                : { exitCode: processResult.exitCode }),
              ...(processResult?.signal === undefined ? {} : { signal: processResult.signal }),
              ...(processResult?.killedByInactivity === undefined
                ? {}
                : { killedByInactivity: processResult.killedByInactivity }),
              ...(settledResultText === undefined ? {} : { resultText: settledResultText }),
              ...(lastCompletedAssistantMessage === undefined
                ? {}
                : { lastCompletedAssistantMessage }),
              ...(settledResultText !== undefined || lastCompletedAssistantMessage !== undefined
                ? {
                    finalMessage:
                      settledResultText !== undefined
                        ? settledResultText
                        : lastCompletedAssistantMessage,
                  }
                : {}),
            })
          );
        }
      })();

      await readyController.ready;
      if (readyController.state === 'failed') {
        throw toError(
          readyController.inputWriter.lastError ??
            new Error(`Claude ${label} persistent input failed during launch`)
        );
      }

      const processControlId = sessionProcessLifecycle?.processId as ProcessControlId | undefined;
      const handle: ClaudePersistentAgentLaunchResult = {
        mode: 'persistent-agent',
        executor: 'claude-code',
        processLabel: sessionProcessLabel as AgentProcessLabel,
        get providerState() {
          return readyController.state;
        },
        input: readyController,
        ready: readyController.ready,
        completion,
        lifecycle,
        ...(processControlId === undefined ? {} : { processControlId }),
        release: async (): Promise<void> => {
          persistentController?.cleanup();
          await cleanup();
        },
      };
      return handle;
    }

    const result = await terminalInputResult.resultPromise;
    acceptedFinalResult = terminalInputResult.acceptedSuccessfulFinalResult();

    await cleanup();

    return {
      acceptedFinalResult,
      killedByTimeout,
      exitCode: result.exitCode,
      killedByInactivity: result.killedByInactivity ?? false,
    };
  } catch (error) {
    if (streaming !== undefined && terminalInputResult === undefined) {
      try {
        safeEndStdin(streaming.stdin, debugLog);
        streaming.kill('SIGTERM');
      } catch (cleanupError) {
        debugLog(`Claude ${label} startup cleanup failed:`, cleanupError);
      }
    } else if (streaming !== undefined && persistentAgent) {
      try {
        // The persistent input controller owns stdin once it exists. Its
        // cleanup path has already closed the sink; only terminate the child
        // here so a failed launch cannot leave a live provider behind.
        streaming.kill('SIGTERM');
      } catch (cleanupError) {
        debugLog(`Claude ${label} startup process termination failed:`, cleanupError);
      }
    }
    try {
      await cleanup();
    } catch (cleanupError) {
      debugLog(`Claude ${label} cleanup after failure failed:`, cleanupError);
    }
    persistentController?.markProviderFailed(error);
    throw error;
  }
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => resolvePromise?.(value),
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
