import type { RmplanConfig } from '../../configSchema';
import { spawnAndLogOutput } from '../../../common/process';
import { error, warn } from '../../../logging';
import { createCodexStdoutFormatter } from './format';

export interface CodexStepOptions {
  /** Path to JSON schema file for structured output */
  outputSchemaPath?: string;
  /** Inactivity timeout in milliseconds. Defaults to 10 minutes (or CODEX_OUTPUT_TIMEOUT_MS env var). */
  inactivityTimeoutMs?: number;
  /** Reasoning effort level for the model. Defaults to 'high'. */
  reasoningLevel?: 'low' | 'medium' | 'high' | 'xhigh';
}

/**
 * Runs a single-step Codex execution with JSON streaming enabled and returns the final agent message.
 */
export async function executeCodexStep(
  prompt: string,
  cwd: string,
  rmplanConfig: RmplanConfig,
  outputSchemaPathOrOptions?: string | CodexStepOptions
): Promise<string> {
  // Handle both old (string) and new (object) signatures for backward compatibility
  const options: CodexStepOptions =
    typeof outputSchemaPathOrOptions === 'string'
      ? { outputSchemaPath: outputSchemaPathOrOptions }
      : (outputSchemaPathOrOptions ?? {});

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

  const reasoningLevel = options.reasoningLevel ?? 'high';
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
    !allowAllTools &&
    rmplanConfig?.isUsingExternalStorage &&
    rmplanConfig.externalRepositoryConfigDir
  ) {
    const writableRoots = JSON.stringify([rmplanConfig.externalRepositoryConfigDir]);
    args.push('-c', `sandbox_workspace_write.writable_roots=${writableRoots}`);
  }

  if (options.outputSchemaPath) {
    args.push('--output-schema', options.outputSchemaPath);
  }

  let lastExitCode: number | undefined;
  let lastSignal: NodeJS.Signals | undefined;
  let threadId: string | undefined;

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
        AGENT: process.env.AGENT || '1',
        RMPLAN_NOTIFY_SUPPRESS: '1',
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
