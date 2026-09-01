import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { TimConfig } from '../../configSchema';
import type { CodexReasoningLevel } from '../schemas.js';
import { spawnAndLogOutput } from '../../../common/process';
import type { TimWorkspaceCommandEnvironmentOptions } from '../../../common/env.js';
import {
  normalizeSubprocessMonitorRules,
  startSubprocessMonitor,
  type SubprocessMonitorHandle,
} from '../../../common/subprocess_monitor';
import { error, warn, debugLog } from '../../../logging';
import { isTunnelActive } from '../../../logging/tunnel_client.js';
import { createCodexStdoutFormatter } from './format';
import { createExecutorTunnelServer, type TunnelServer } from '../../../logging/tunnel_server.js';
import { createPromptRequestHandler } from '../../../logging/tunnel_prompt_handler.js';
import { TIM_OUTPUT_SOCKET } from '../../../logging/tunnel_protocol.js';
import { executeCodexStepViaAppServer } from './app_server_runner';
import { isCodexAppServerEnabled } from './app_server_mode';
import {
  CODEX_DYNAMIC_TOOLS_APP_SERVER_REQUIRED_ERROR_MESSAGE,
  validateCodexDynamicToolProvider,
  type CodexDynamicToolProvider,
} from './app_server_dynamic_tools.js';
import {
  buildOutputSchemaConversionPrompt,
  buildOutputSchemaCorrectionPrompt,
  validateJsonOutputAgainstSchema,
} from './schema_output';
import type { DeferredAgentInputAdapter } from '../../agent_messaging/agent_input_adapter.js';
import {
  withAgentEnvironmentIdentity,
  type AgentEnvironmentIdentity,
} from '../../agent_messaging/environment.js';

export {
  startPersistentCodexAgent,
  validateCodexPersistentAgentLaunchOptions,
} from './persistent_codex_session.js';
export type { CodexPersistentAgentLaunchOptions } from './persistent_codex_session.js';
export { createCodexAgentLauncher } from './codex_agent_launcher.js';
export type { CodexAgentLauncherOptions } from './codex_agent_launcher.js';
export { createCodexAgentToolDispatcher } from './codex_agent_tools.js';

export type CodexAppServerMode = 'single-turn' | 'chat-session' | 'single-turn-with-steering';

export interface CodexStepOptions {
  /** Optional model override passed through from executor/shared options. */
  model?: string;
  /** Path to JSON schema file for structured output */
  outputSchemaPath?: string;
  /** Inline JSON schema object for structured output. Only used in app-server mode (CODEX_USE_APP_SERVER). */
  outputSchema?: Record<string, unknown>;
  /** Inactivity timeout in milliseconds. Defaults to 10 minutes (or CODEX_OUTPUT_TIMEOUT_MS env var). */
  inactivityTimeoutMs?: number;
  /** Reasoning effort level for the model. Defaults to 'high'. */
  reasoningLevel?: CodexReasoningLevel;
  /** App-server interaction mode. Defaults to single-turn. */
  appServerMode?: CodexAppServerMode;
  /** Enable local terminal input forwarding for app-server interactive modes. */
  terminalInput?: boolean;
  /** Project environment rendering options for Codex subprocesses. */
  timEnvironment?: TimWorkspaceCommandEnvironmentOptions;
  /** Trusted agent identity applied after all workspace environment layers. */
  agentEnvironmentIdentity?: AgentEnvironmentIdentity;
  /** One trusted, role-bound provider for experimental Codex dynamic tools. */
  dynamicToolProvider?: CodexDynamicToolProvider;
  /** Deferred root input bound by the active orchestrator app-server turn. */
  orchestratorInputAdapter?: DeferredAgentInputAdapter;
}

/**
 * Runs a single-step Codex execution with JSON streaming enabled and returns the final agent message.
 */
export async function executeCodexStep(
  prompt: string,
  cwd: string,
  timConfig: TimConfig,
  outputSchemaPathOrOptions?: string | CodexStepOptions
): Promise<string> {
  // Handle both old (string) and new (object) signatures for backward compatibility
  const options: CodexStepOptions =
    typeof outputSchemaPathOrOptions === 'string'
      ? { outputSchemaPath: outputSchemaPathOrOptions }
      : (outputSchemaPathOrOptions ?? {});

  if (options.dynamicToolProvider) {
    validateCodexDynamicToolProvider(options.dynamicToolProvider);
    if (!isCodexAppServerEnabled()) {
      throw new Error(CODEX_DYNAMIC_TOOLS_APP_SERVER_REQUIRED_ERROR_MESSAGE);
    }
  }

  const hasOutputSchema = !!(options.outputSchemaPath || options.outputSchema);
  const outputSchemaForValidation =
    options.outputSchema ??
    (options.outputSchemaPath ? await readOutputSchemaFile(options.outputSchemaPath) : undefined);
  const optionsForExecution =
    outputSchemaForValidation && !options.outputSchema
      ? { ...options, outputSchema: outputSchemaForValidation as Record<string, unknown> }
      : options;

  if (isCodexAppServerEnabled()) {
    return executeCodexStepViaAppServer(prompt, cwd, timConfig, optionsForExecution);
  }

  // Validate subprocess monitor rules up front, before any resource allocation,
  // so a bad regex fails cleanly without leaking tunnel servers or temp dirs.
  const subprocessMonitorRules = timConfig.subprocessMonitor?.rules;
  if (subprocessMonitorRules?.length) {
    normalizeSubprocessMonitorRules(subprocessMonitorRules);
  }

  const inactivityOverride = Number.parseInt(process.env.CODEX_OUTPUT_TIMEOUT_MS || '', 10);
  const inactivityTimeoutMs =
    options.inactivityTimeoutMs ??
    (Number.isFinite(inactivityOverride) && inactivityOverride > 0
      ? inactivityOverride
      : 10 * 60 * 1000); // 10 minutes default

  const maxAttempts = 3;
  const allowAllTools = ['true', '1'].includes(process.env.ALLOW_ALL_TOOLS || '');
  const sandboxSettings = allowAllTools
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : ['--sandbox', 'workspace-write'];

  const reasoningLevel = options.reasoningLevel ?? 'medium';
  const args = [
    'codex',
    '--enable',
    'web_search_request',
    'exec',
    '-c',
    `model_reasoning_effort=${reasoningLevel}`,
    ...sandboxSettings,
  ];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (
    !allowAllTools &&
    timConfig?.isUsingExternalStorage &&
    timConfig.externalRepositoryConfigDir
  ) {
    const writableRoots = JSON.stringify([timConfig.externalRepositoryConfigDir]);
    args.push('-c', `sandbox_workspace_write.writable_roots=${writableRoots}`);
  }

  if (options.outputSchemaPath) {
    args.push('--output-schema', options.outputSchemaPath);
  }

  // Create tunnel server for output forwarding from child processes
  let tunnelServer: TunnelServer | undefined;
  let tunnelTempDir: string | undefined;
  let tunnelSocketPath: string | undefined;
  if (!isTunnelActive()) {
    try {
      tunnelTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-tunnel-'));
      tunnelSocketPath = path.join(tunnelTempDir, 'output.sock');
      const promptHandler = createPromptRequestHandler();
      tunnelServer = await createExecutorTunnelServer(tunnelSocketPath, {
        onPromptRequest: promptHandler,
      });
    } catch (err) {
      debugLog('Could not create tunnel server for output forwarding:', err);
    }
  }

  const tunnelEnv: Record<string, string> =
    tunnelServer && tunnelSocketPath ? { [TIM_OUTPUT_SOCKET]: tunnelSocketPath } : {};

  let lastExitCode: number | undefined;
  let lastSignal: NodeJS.Signals | undefined;
  let threadId: string | undefined;
  let schemaCorrectionRequested = false;
  let schemaConversionRequested = false;
  let firstSchemaInvalidOutput: string | undefined;
  let firstSchemaValidationError: string | undefined;
  let resumePrompt = 'continue';
  let freshPrompt = prompt;

  try {
    for (
      let attempt = 1, maxTotalAttempts = hasOutputSchema ? maxAttempts + 1 : maxAttempts;
      attempt <= maxTotalAttempts;
      attempt++
    ) {
      const formatter = createCodexStdoutFormatter(options.model);
      const attemptArgs = [...args];
      if (attempt === 1 || !threadId) {
        attemptArgs.push('--json', freshPrompt);
        if (attempt > 1 && !threadId) {
          warn('Codex retry requested as a fresh run.');
        }
      } else {
        attemptArgs.push('--json', 'resume', threadId, resumePrompt);
        resumePrompt = 'continue';
      }

      let monitorHandle: SubprocessMonitorHandle | undefined;
      let result: Awaited<ReturnType<typeof spawnAndLogOutput>>;
      try {
        result = await spawnAndLogOutput(attemptArgs, {
          sessionProcessLabel: `Codex CLI attempt ${attempt}`,
          cwd,
          env: {
            TIM_EXECUTOR: 'codex',
            AGENT: process.env.AGENT || '1',
            TIM_NOTIFY_SUPPRESS: '1',
            ...tunnelEnv,
          },
          agentName: options.agentEnvironmentIdentity?.name,
          timEnvironment: options.timEnvironment,
          transformEnvironment: options.agentEnvironmentIdentity
            ? (env: Record<string, string>): Record<string, string> =>
                withAgentEnvironmentIdentity(env, options.agentEnvironmentIdentity!)
            : undefined,
          formatStdout: formatter ? (chunk: string) => formatter.formatChunk(chunk) : undefined,
          inactivityTimeoutMs,
          initialInactivityTimeoutMs: 60 * 1000, // 1 minute before first output
          onInactivityKill: () => {
            const minutes = Math.round(inactivityTimeoutMs / 60000);
            warn(
              `Codex produced no output for ${minutes} minute${minutes === 1 ? '' : 's'}; terminating attempt ${attempt}/${maxAttempts}.`
            );
          },
          onSpawn: (pid) => {
            if (subprocessMonitorRules?.length) {
              monitorHandle = startSubprocessMonitor({
                rootPid: pid,
                rules: subprocessMonitorRules,
                pollIntervalSeconds: timConfig.subprocessMonitor?.pollIntervalSeconds,
                logger: { warn },
              });
            }
          },
          // stderr is not JSON – print as-is
        });
      } finally {
        monitorHandle?.stop();
      }

      const { exitCode, signal, killedByInactivity } = result;

      threadId ||= formatter?.getThreadId?.();

      const inferredSignal = signal ?? inferSignalFromExitCode(exitCode);
      const shouldRetry =
        exitCode !== 0 ||
        killedByInactivity ||
        inferredSignal === 'SIGTERM' ||
        inferredSignal === 'SIGKILL';

      if (shouldRetry) {
        lastExitCode = exitCode;
        lastSignal = inferredSignal;

        if (attempt < maxAttempts) {
          const reason = describeTermination(exitCode, inferredSignal, killedByInactivity);
          warn(`Codex attempt ${attempt}/${maxAttempts} ${reason}; retrying...`);
          continue;
        }

        const reason = describeTermination(exitCode, inferredSignal, killedByInactivity);
        throw new Error(`codex failed after ${maxAttempts} attempts (${reason}).`);
      }

      // Prefer a FAILED agent message when available to surface failures reliably
      const failedMsg =
        typeof (formatter as any).getFailedAgentMessage === 'function'
          ? (formatter as any).getFailedAgentMessage()
          : undefined;
      const final = failedMsg || formatter.getFinalAgentMessage();
      if (!final) {
        // Provide helpful context for debugging
        error('Codex returned no final agent message. Enable debug logs for details.');
        throw new Error('No final agent message found in Codex output.');
      }

      if (outputSchemaForValidation) {
        const validation = validateJsonOutputAgainstSchema(final, outputSchemaForValidation);
        if (validation.valid) {
          return final;
        }
        firstSchemaInvalidOutput ??= final;
        firstSchemaValidationError ??= validation.error;
        if (!schemaCorrectionRequested && threadId) {
          schemaCorrectionRequested = true;
          resumePrompt = buildOutputSchemaCorrectionPrompt(
            outputSchemaForValidation,
            validation.error
          );
          warn(
            'Codex returned output that does not match the schema; requesting corrected JSON output.'
          );
          continue;
        }
        if (!schemaConversionRequested && firstSchemaInvalidOutput) {
          schemaConversionRequested = true;
          freshPrompt = buildOutputSchemaConversionPrompt({
            schema: outputSchemaForValidation,
            failedOutput: firstSchemaInvalidOutput,
            validationError: firstSchemaValidationError,
          });
          threadId = undefined;
          warn(
            'Codex schema correction still did not match the schema; starting a fresh JSON conversion run.'
          );
          continue;
        }

        throw new Error(
          `Codex returned output that does not match the schema.${validation.error ? ` ${validation.error}` : ''}`
        );
      }

      return final;
    }

    throw new Error(
      `codex failed after ${maxAttempts} attempts with code ${lastExitCode ?? 'unknown'}${lastSignal ? ` (signal ${lastSignal})` : ''}.`
    );
  } finally {
    // Clean up tunnel server and temp directory
    tunnelServer?.close();
    if (tunnelTempDir) {
      await fs.rm(tunnelTempDir, { recursive: true, force: true });
    }
  }
}

async function readOutputSchemaFile(outputSchemaPath: string): Promise<unknown> {
  const schemaContent = await fs.readFile(outputSchemaPath, 'utf8');
  return JSON.parse(schemaContent);
}

function inferSignalFromExitCode(exitCode: number | null): NodeJS.Signals | undefined {
  // POSIX convention: 128 + signal number
  if (exitCode === 137) return 'SIGKILL';
  if (exitCode === 143) return 'SIGTERM';
  return undefined;
}

function describeTermination(
  exitCode: number,
  signal: NodeJS.Signals | undefined,
  killedByInactivity: boolean
): string {
  const parts: string[] = [];

  if (killedByInactivity) {
    parts.push('was terminated after inactivity');
  }

  if (signal) {
    parts.push(`received ${signal}`);
  } else if (exitCode !== 0) {
    parts.push(`exited with code ${exitCode}`);
  }

  return parts.join(' ') || 'terminated unexpectedly';
}
