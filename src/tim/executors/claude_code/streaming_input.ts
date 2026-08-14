import type { StreamingProcess } from '../../../common/process.ts';
import type { FileSink } from 'bun';
import type {
  AgentInputActivity,
  AgentInputAdapter,
  AgentInputDelivery,
  AgentInputMessage,
} from '../../agent_messaging/agent_manager_types.js';
import type { ClaudePersistentAgentState } from './persistent_agent_contract.js';

export function buildSingleUserInputMessageLine(content: string): string {
  const inputMessage = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  });
  return `${inputMessage}\n`;
}

export function sendInitialPrompt(streamingProcess: StreamingProcess, content: string): void {
  void streamingProcess.stdin.write(buildSingleUserInputMessageLine(content));
}

export function sendFollowUpMessage(stdin: FileSink, content: string): void {
  void stdin.write(buildSingleUserInputMessageLine(content));
}

export function safeEndStdin(stdin: FileSink, debugLog: (...args: unknown[]) => void): void {
  try {
    const endResult = stdin.end();
    Promise.resolve(endResult).catch((err) => {
      debugLog('Failed to close stdin: %s', err as Error);
    });
  } catch (err) {
    debugLog('Failed to close stdin: %s', err as Error);
  }
}

export type PersistentClaudeInputAcknowledgement = Exclude<
  AgentInputDelivery,
  'temporarily-unavailable'
>;

export type PersistentClaudeInputWriteResult =
  | {
      readonly status: 'accepted';
      readonly acknowledgement: PersistentClaudeInputAcknowledgement;
      readonly generation: number;
    }
  | {
      readonly status: 'temporarily-unavailable';
      readonly reason: 'not-ready' | 'write-in-progress';
    }
  | {
      readonly status: 'closed-or-failed';
      readonly error?: unknown;
    };

export interface PersistentClaudeInputWriterOptions {
  readonly stdin: FileSink;
  readonly debugLog: (...args: unknown[]) => void;
  readonly onAvailabilityChange?: () => void;
  /** Called after a write failure so the provider can decide whether to fail. */
  readonly onWriteFailure?: (error: unknown) => void;
}

/** Raised when the provider input stream cannot accept a persistent message. */
export class ClaudePersistentInputClosedError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ClaudePersistentInputClosedError';
  }
}

/**
 * The single serialized stream-json input owner for a persistent Claude run.
 *
 * This class deliberately has no message queue. A busy or not-yet-ready
 * writer returns temporary unavailability so the shared AgentManager mailbox
 * remains the only bounded FIFO.
 */
export class PersistentClaudeInputWriter implements AgentInputAdapter {
  private readonly readyPromise: Promise<void>;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: unknown) => void) | undefined;
  private readySettled = false;
  private readyState = false;
  private providerState: ClaudePersistentAgentState = 'spawning';
  private generationValue = 0;
  private writeInProgress = false;
  private stdinEnded = false;
  private lastWriteError: unknown;
  private readonly availabilityListeners = new Set<() => void>();

  public constructor(private readonly options: PersistentClaudeInputWriterOptions) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    if (options.onAvailabilityChange !== undefined) {
      this.availabilityListeners.add(options.onAvailabilityChange);
    }
  }

  public get ready(): Promise<void> {
    return this.readyPromise;
  }

  public get isReady(): boolean {
    return this.readyState;
  }

  public get activity(): AgentInputActivity {
    switch (this.providerState) {
      case 'active':
      case 'result-pending-background':
      case 'finish-after-result':
      case 'graceful-stop-active':
        return 'active';
      case 'idle':
        return 'idle';
      case 'spawning':
        return 'not-ready';
      case 'closing':
      case 'exited':
      case 'failed':
        return 'temporarily-unavailable';
    }
  }

  public get state(): ClaudePersistentAgentState {
    return this.providerState;
  }

  public get generation(): number {
    return this.generationValue;
  }

  public get isWriteInProgress(): boolean {
    return this.writeInProgress;
  }

  public get lastError(): unknown {
    return this.lastWriteError;
  }

  public onAvailabilityChange(listener: () => void): () => void {
    this.availabilityListeners.add(listener);
    return (): void => {
      this.availabilityListeners.delete(listener);
    };
  }

  /** Mark the subprocess input as ready for its initial active turn. */
  public markReady(activity: 'active' | 'idle' = 'active'): void {
    if (this.isTerminal()) return;
    this.providerState = activity;
    this.readyState = true;
    this.resolveReadyPromise();
    this.notifyAvailabilityChange();
  }

  /**
   * Advance provider-local state from the parser/controller. A generation
   * change prevents an old failed write from restoring a newer state.
   */
  public markProviderState(state: ClaudePersistentAgentState): void {
    if (this.isTerminal() && state !== 'exited' && state !== 'failed') return;
    this.generationValue += 1;
    this.providerState = state;
    if (state === 'active' || state === 'result-pending-background' || state === 'idle') {
      this.readyState = true;
      this.resolveReadyPromise();
    } else if (state === 'spawning') {
      this.readyState = false;
    } else {
      this.readyState = false;
    }
    if (state === 'failed' && !this.readySettled) {
      this.rejectReady?.(this.lastWriteError ?? new Error('Claude persistent input failed'));
      this.readySettled = true;
    }
    this.notifyAvailabilityChange();
  }

  /** Mark startup as failed and close this input owner. */
  public fail(error: unknown): void {
    this.lastWriteError = error;
    this.generationValue += 1;
    this.providerState = 'failed';
    this.readyState = false;
    if (!this.readySettled) {
      this.rejectReady?.(error);
      this.readySettled = true;
    }
    this.endStdinOnce();
    this.notifyAvailabilityChange();
  }

  /** Close stdin once. Late deliveries return closed-or-failed. */
  public close(error?: unknown): void {
    if (this.stdinEnded) return;
    this.generationValue += 1;
    this.providerState = 'closing';
    this.readyState = false;
    if (error !== undefined) this.lastWriteError = error;
    if (!this.readySettled) {
      this.rejectReady?.(error ?? new Error('Claude persistent input closed before readiness'));
      this.readySettled = true;
    }
    this.endStdinOnce();
    this.notifyAvailabilityChange();
  }

  public async release(): Promise<void> {
    this.close();
  }

  /**
   * Deliver one message through the provider-neutral adapter contract.
   * Closed/failed writes reject because the provider-neutral contract has no
   * closed result; the mailbox binding treats that as temporary delivery
   * failure and retains its message.
   */
  public deliver(message: AgentInputMessage): AgentInputDelivery | Promise<AgentInputDelivery> {
    const result = this.writeUserMessage(message.content);
    if (isPromiseLike(result)) {
      return result.then((outcome) => this.toAgentInputDelivery(outcome));
    }
    return this.toAgentInputDelivery(result);
  }

  /** Write one user record without retaining it when the sink is busy. */
  public writeUserMessage(
    content: string
  ): PersistentClaudeInputWriteResult | Promise<PersistentClaudeInputWriteResult> {
    if (this.stdinEnded || this.isTerminal() || this.providerState === 'closing') {
      return this.closedResult();
    }
    if (!this.readyState || this.providerState === 'spawning') {
      return { status: 'temporarily-unavailable', reason: 'not-ready' };
    }
    if (this.writeInProgress) {
      return { status: 'temporarily-unavailable', reason: 'write-in-progress' };
    }
    const wasIdle = this.providerState === 'idle';
    const writeGeneration = this.generationValue + 1;
    this.generationValue = writeGeneration;
    if (wasIdle) {
      // Claim idle synchronously, before calling or awaiting FileSink.write().
      this.providerState = 'active';
    }

    this.writeInProgress = true;
    let writeResult: number | Promise<number>;
    try {
      writeResult = this.options.stdin.write(buildSingleUserInputMessageLine(content));
    } catch (error) {
      return this.finishWriteFailure(error, wasIdle, writeGeneration);
    }

    if (!isPromiseLike(writeResult)) {
      return this.finishWriteSuccess(writeGeneration, wasIdle);
    }

    const pending = Promise.resolve(writeResult).then(
      (): PersistentClaudeInputWriteResult => this.finishWriteSuccess(writeGeneration, wasIdle),
      (error: unknown): PersistentClaudeInputWriteResult =>
        this.finishWriteFailure(error, wasIdle, writeGeneration)
    );
    return pending;
  }

  private finishWriteSuccess(
    writeGeneration: number,
    wasIdle: boolean
  ): PersistentClaudeInputWriteResult {
    this.writeInProgress = false;
    if (this.stdinEnded || this.providerState === 'closing' || this.isTerminal()) {
      this.notifyAvailabilityChange();
      return this.closedResult();
    }
    this.notifyAvailabilityChange();
    return {
      status: 'accepted',
      acknowledgement: wasIdle ? 'started-idle-turn' : 'steered',
      generation: writeGeneration,
    };
  }

  private finishWriteFailure(
    error: unknown,
    wasIdle: boolean,
    writeGeneration: number
  ): PersistentClaudeInputWriteResult {
    this.writeInProgress = false;
    this.lastWriteError = error;
    const wasCurrentGeneration = this.generationValue === writeGeneration;

    // Only the generation that claimed idle may restore it. A later parser or
    // shutdown transition must never be overwritten by this old write.
    if (
      wasIdle &&
      this.generationValue === writeGeneration &&
      this.providerState === 'active' &&
      !this.stdinEnded
    ) {
      this.providerState = 'idle';
      this.generationValue += 1;
    }

    try {
      if (this.options.onWriteFailure !== undefined) {
        this.options.onWriteFailure(error);
      } else if (wasCurrentGeneration) {
        // A failed sink is not safe to reuse unless the provider supplied a
        // controller that can classify the failure and take another action.
        this.fail(error);
      }
    } catch (callbackError) {
      this.options.debugLog('Persistent Claude input failure callback failed: %s', callbackError);
    }
    this.notifyAvailabilityChange();
    return { status: 'closed-or-failed', error };
  }

  private toAgentInputDelivery(result: PersistentClaudeInputWriteResult): AgentInputDelivery {
    switch (result.status) {
      case 'accepted':
        return result.acknowledgement;
      case 'temporarily-unavailable':
        return result.status;
      case 'closed-or-failed':
        throw new ClaudePersistentInputClosedError(
          'Claude persistent input is closed or failed',
          result.error === undefined ? undefined : { cause: result.error }
        );
    }
  }

  private closedResult(): PersistentClaudeInputWriteResult {
    return {
      status: 'closed-or-failed',
      ...(this.lastWriteError === undefined ? {} : { error: this.lastWriteError }),
    };
  }

  private isTerminal(): boolean {
    return this.providerState === 'exited' || this.providerState === 'failed';
  }

  private resolveReadyPromise(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady?.();
  }

  private endStdinOnce(): void {
    if (this.stdinEnded) return;
    this.stdinEnded = true;
    safeEndStdin(this.options.stdin, this.options.debugLog);
  }

  private notifyAvailabilityChange(): void {
    for (const listener of this.availabilityListeners) {
      try {
        listener();
      } catch (error) {
        this.options.debugLog('Persistent Claude input availability callback failed: %s', error);
      }
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}
