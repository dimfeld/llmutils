export const BACKGROUND_DRAIN_GRACE_MS = 10_000;
export const DEFAULT_BACKGROUND_TASK_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const DEV_SERVER_BACKGROUND_TASK_TIMEOUT_MS = 20 * 60 * 1000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface BackgroundTaskStartedInfo {
  taskType?: string;
  description?: string;
}

export interface BackgroundActivityTrackerOptions {
  onClose: () => void;
  graceMs?: number;
  defaultTaskTimeoutMs?: number;
  devServerTaskTimeoutMs?: number;
  setTimeoutFn?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

export class BackgroundActivityTracker {
  private readonly activeTasks = new Set<string>();
  private readonly taskTimeoutTimers = new Map<string, TimerHandle>();
  private wakeupPending = false;
  private everDeferred = false;
  private pendingResultSuccessful: boolean | undefined;
  private closed = false;
  private acceptedFinalSuccessfulResult = false;
  private graceTimer: TimerHandle | undefined;
  private readonly onClose: () => void;
  private readonly graceMs: number;
  private readonly defaultTaskTimeoutMs: number;
  private readonly devServerTaskTimeoutMs: number;
  private readonly setTimeoutFn: (callback: () => void, ms: number) => TimerHandle;
  private readonly clearTimeoutFn: (handle: TimerHandle) => void;

  constructor(options: BackgroundActivityTrackerOptions) {
    this.onClose = options.onClose;
    this.graceMs = options.graceMs ?? BACKGROUND_DRAIN_GRACE_MS;
    this.defaultTaskTimeoutMs = options.defaultTaskTimeoutMs ?? DEFAULT_BACKGROUND_TASK_TIMEOUT_MS;
    this.devServerTaskTimeoutMs =
      options.devServerTaskTimeoutMs ?? DEV_SERVER_BACKGROUND_TASK_TIMEOUT_MS;
    this.setTimeoutFn =
      options.setTimeoutFn ??
      ((callback: () => void, ms: number): TimerHandle => setTimeout(callback, ms));
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((handle: TimerHandle): void => {
        clearTimeout(handle);
      });
  }

  taskStarted(id: string, info: BackgroundTaskStartedInfo = {}): void {
    if (this.closed) {
      return;
    }

    this.invalidateAcceptedFinalResult();
    this.activeTasks.add(id);
    this.everDeferred = true;
    this.scheduleTaskTimeout(id, this.getTaskTimeoutMs(info));
    this.cancelGraceTimer();
  }

  taskEnded(id: string): void {
    if (this.closed) {
      return;
    }

    this.activeTasks.delete(id);
    this.cancelTaskTimeout(id);
    this.evaluateDrain();
  }

  wakeupScheduled(): void {
    if (this.closed) {
      return;
    }

    this.clearPostResultWindow();
    this.wakeupPending = true;
    this.everDeferred = true;
    this.cancelGraceTimer();
  }

  onTurnActivity(): void {
    if (
      this.closed ||
      (this.pendingResultSuccessful === undefined && !this.acceptedFinalSuccessfulResult)
    ) {
      return;
    }

    this.clearPostResultWindow();
  }

  /**
   * The turn produced a result, but the caller is intercepting it to keep stdin
   * open with an explicit continuation. That continuation supersedes any
   * scheduled wakeup from the intercepted turn while preserving active tasks.
   */
  onInterceptedResult(): void {
    this.onContinuationStarted();
  }

  onContinuationStarted(): void {
    if (this.closed) {
      return;
    }

    this.clearPostResultWindow();
  }

  hasPendingActivity(): boolean {
    return this.activeTasks.size > 0 || this.wakeupPending;
  }

  onResultMessage(resultWasSuccessful: boolean): void {
    if (this.closed) {
      return;
    }

    this.pendingResultSuccessful = resultWasSuccessful;
    this.acceptedFinalSuccessfulResult = false;

    if (this.hasPendingActivity()) {
      this.cancelGraceTimer();
      return;
    }

    if (this.everDeferred) {
      this.startGraceTimer();
      return;
    }

    this.close();
  }

  acceptResultWithoutClosing(resultWasSuccessful: boolean): void {
    if (this.closed) {
      return;
    }

    this.pendingResultSuccessful = resultWasSuccessful;

    if (this.hasPendingActivity()) {
      this.acceptedFinalSuccessfulResult = false;
      this.cancelGraceTimer();
      return;
    }

    this.acceptedFinalSuccessfulResult = resultWasSuccessful;
  }

  acceptedSuccessfulFinalResult(): boolean {
    return this.acceptedFinalSuccessfulResult;
  }

  cancel(): void {
    this.cancelGraceTimer();
    this.cancelTaskTimeouts();
  }

  forceClose(): void {
    this.cancelGraceTimer();
    this.cancelTaskTimeouts();
    this.closeWithoutAcceptingResult();
  }

  private getTaskTimeoutMs(info: BackgroundTaskStartedInfo): number {
    const taskType = info.taskType?.toLowerCase();
    const description = info.description?.toLowerCase() ?? '';

    if (taskType === 'local_bash' && /\bdev\s+server\b/.test(description)) {
      return this.devServerTaskTimeoutMs;
    }

    return this.defaultTaskTimeoutMs;
  }

  private scheduleTaskTimeout(id: string, timeoutMs: number): void {
    this.cancelTaskTimeout(id);
    const handle = this.setTimeoutFn((): void => {
      this.taskTimeoutTimers.delete(id);
      if (this.closed) {
        return;
      }
      this.activeTasks.delete(id);
      this.evaluateDrain();
    }, timeoutMs);
    this.taskTimeoutTimers.set(id, handle);
  }

  private cancelTaskTimeout(id: string): void {
    const handle = this.taskTimeoutTimers.get(id);
    if (!handle) {
      return;
    }

    this.clearTimeoutFn(handle);
    this.taskTimeoutTimers.delete(id);
  }

  private cancelTaskTimeouts(): void {
    for (const handle of this.taskTimeoutTimers.values()) {
      this.clearTimeoutFn(handle);
    }
    this.taskTimeoutTimers.clear();
  }

  private evaluateDrain(): void {
    if (this.closed) {
      return;
    }

    if (this.hasPendingActivity()) {
      this.cancelGraceTimer();
      return;
    }

    if (!this.everDeferred || this.pendingResultSuccessful === undefined) {
      return;
    }

    this.startGraceTimer();
  }

  private startGraceTimer(): void {
    this.cancelGraceTimer();
    this.graceTimer = this.setTimeoutFn((): void => {
      this.graceTimer = undefined;
      this.close();
    }, this.graceMs);
  }

  private cancelGraceTimer(): void {
    if (!this.graceTimer) {
      return;
    }

    this.clearTimeoutFn(this.graceTimer);
    this.graceTimer = undefined;
  }

  private clearPostResultWindow(): void {
    this.wakeupPending = false;
    this.pendingResultSuccessful = undefined;
    this.acceptedFinalSuccessfulResult = false;
    this.cancelGraceTimer();
  }

  private invalidateAcceptedFinalResult(): void {
    if (this.pendingResultSuccessful !== undefined) {
      this.pendingResultSuccessful = false;
    }
    this.acceptedFinalSuccessfulResult = false;
  }

  private close(): void {
    if (this.closed) {
      return;
    }

    this.acceptedFinalSuccessfulResult = this.pendingResultSuccessful === true;
    this.closeWithoutAcceptingResult();
  }

  private closeWithoutAcceptingResult(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.pendingResultSuccessful = undefined;
    this.cancelTaskTimeouts();
    this.cancelGraceTimer();
    this.onClose();
  }
}
