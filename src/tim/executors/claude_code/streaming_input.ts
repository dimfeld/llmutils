import type { StreamingProcess } from '../../../common/process.ts';
import type { FileSink } from 'bun';

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

export type PersistentClaudeInputWriteResult =
  | {
      readonly status: 'accepted';
    }
  | {
      readonly status: 'temporarily-unavailable';
      readonly reason: 'not-ready' | 'write-in-progress';
    }
  | {
      readonly status: 'failed';
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
export class PersistentClaudeInputWriter {
  private readonly readyPromise: Promise<void>;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: unknown) => void) | undefined;
  private readySettled = false;
  private readyState = false;
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

  public get isClosed(): boolean {
    return this.stdinEnded;
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

  /** Mark the subprocess input as ready for its initial turn. */
  public markReady(): void {
    if (this.stdinEnded) return;
    this.readyState = true;
    this.resolveReadyPromise();
    this.notifyAvailabilityChange();
  }

  /** Mark the provider as exited without writing another end marker. */
  public markProviderExited(): void {
    if (this.stdinEnded) return;
    this.stdinEnded = true;
    this.readyState = false;
    this.rejectReadyBeforeReady(new Error('Claude persistent input exited before readiness'));
    this.notifyAvailabilityChange();
  }

  /** Mark startup as failed and close this input owner. */
  public fail(error: unknown): void {
    this.lastWriteError = error;
    this.readyState = false;
    this.rejectReadyBeforeReady(error);
    this.endStdinOnce();
    this.notifyAvailabilityChange();
  }

  /** Close stdin once. Late deliveries return closed-or-failed. */
  public close(error?: unknown): void {
    if (this.stdinEnded) return;
    this.readyState = false;
    if (error !== undefined) this.lastWriteError = error;
    this.rejectReadyBeforeReady(
      error ?? new Error('Claude persistent input closed before readiness')
    );
    this.endStdinOnce();
    this.notifyAvailabilityChange();
  }

  public async release(): Promise<void> {
    this.close();
  }

  /** Write one user record without retaining it when the sink is busy. */
  public writeUserMessage(
    content: string
  ): PersistentClaudeInputWriteResult | Promise<PersistentClaudeInputWriteResult> {
    if (this.stdinEnded) {
      return this.closedResult();
    }
    if (!this.readyState) {
      return { status: 'temporarily-unavailable', reason: 'not-ready' };
    }
    if (this.writeInProgress) {
      return { status: 'temporarily-unavailable', reason: 'write-in-progress' };
    }

    this.writeInProgress = true;
    let writeResult: number | Promise<number>;
    try {
      writeResult = this.options.stdin.write(buildSingleUserInputMessageLine(content));
    } catch (error) {
      return this.finishWriteFailure(error);
    }

    if (!isPromiseLike(writeResult)) {
      return this.finishWriteSuccess();
    }

    const pending = Promise.resolve(writeResult).then(
      (): PersistentClaudeInputWriteResult => this.finishWriteSuccess(),
      (error: unknown): PersistentClaudeInputWriteResult => this.finishWriteFailure(error)
    );
    return pending;
  }

  private finishWriteSuccess(): PersistentClaudeInputWriteResult {
    this.writeInProgress = false;
    if (this.stdinEnded) {
      this.notifyAvailabilityChange();
      return this.closedResult();
    }
    this.notifyAvailabilityChange();
    return { status: 'accepted' };
  }

  private finishWriteFailure(error: unknown): PersistentClaudeInputWriteResult {
    this.writeInProgress = false;
    this.lastWriteError = error;

    try {
      if (this.options.onWriteFailure !== undefined) {
        this.options.onWriteFailure(error);
      } else {
        // A failed sink is not safe to reuse unless the provider supplied a
        // controller that can classify the failure and take another action.
        this.fail(error);
      }
    } catch (callbackError) {
      this.options.debugLog('Persistent Claude input failure callback failed: %s', callbackError);
    }
    this.notifyAvailabilityChange();
    return { status: 'failed', error };
  }

  private closedResult(): PersistentClaudeInputWriteResult {
    return {
      status: 'failed',
      ...(this.lastWriteError === undefined ? {} : { error: this.lastWriteError }),
    };
  }

  private resolveReadyPromise(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady?.();
  }

  private rejectReadyBeforeReady(error: unknown): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.rejectReady?.(error);
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
