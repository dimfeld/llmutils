import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { TimConfig } from '../../configSchema';
import { spawnAndLogOutput } from '../../../common/process';
import { error, warn, debugLog } from '../../../logging';
import { isTunnelActive } from '../../../logging/tunnel_client.js';
import { createCodexStdoutFormatter } from './format';
import { createTunnelServer, type TunnelServer } from '../../../logging/tunnel_server.js';
import { createPromptRequestHandler } from '../../../logging/tunnel_prompt_handler.js';
import { TIM_OUTPUT_SOCKET } from '../../../logging/tunnel_protocol.js';
import { executeCodexStepViaAppServer } from './app_server_runner';
import { isCodexAppServerEnabled } from './app_server_mode';

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
  reasoningLevel?: 'low' | 'medium' | 'high' | 'xhigh';
  /** App-server interaction mode. Defaults to single-turn. */
  appServerMode?: CodexAppServerMode;
  /** Enable local terminal input forwarding for app-server interactive modes. */
  terminalInput?: boolean;
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

  if (isCodexAppServerEnabled()) {
    return executeCodexStepViaAppServer(prompt, cwd, timConfig, options);
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
      tunnelServer = await createTunnelServer(tunnelSocketPath, { onPromptRequest: promptHandler });
    } catch (err) {
      debugLog('Could not create tunnel server for output forwarding:', err);
    }
  }

  const tunnelEnv: Record<string, string> =
    tunnelServer && tunnelSocketPath ? { [TIM_OUTPUT_SOCKET]: tunnelSocketPath } : {};

  let lastExitCode: number | undefined;
  let lastSignal: NodeJS.Signals | undefined;
  let threadId: string | undefined;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const formatter = createCodexStdoutFormatter();
      const attemptArgs = [...args];
      if (attempt === 1 || !threadId) {
        attemptArgs.push('--json', prompt);
        if (attempt > 1 && !threadId) {
          warn('Codex retry requested but no thread id was captured; issuing a fresh run.');
        }
      } else {
        attemptArgs.push(
          '--json',
          'resume',
          threadId,
          // We just prompt "continue" since we're resuming and it should still have the previous context
          'continue'
        );
      }

      const result = await spawnAndLogOutput(attemptArgs, {
        cwd,
        env: {
          ...process.env,
          TIM_EXECUTOR: 'codex',
          AGENT: process.env.AGENT || '1',
          TIM_NOTIFY_SUPPRESS: '1',
          ...tunnelEnv,
        },
        formatStdout: formatter ? (chunk: string) => formatter.formatChunk(chunk) : undefined,
        inactivityTimeoutMs,
        initialInactivityTimeoutMs: 60 * 1000, // 1 minute before first output
        onInactivityKill: () => {
          const minutes = Math.round(inactivityTimeoutMs / 60000);
          warn(
            `Codex produced no output for ${minutes} minute${minutes === 1 ? '' : 's'}; terminating attempt ${attempt}/${maxAttempts}.`
          );
        },
        // stderr is not JSON – print as-is
      });

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
