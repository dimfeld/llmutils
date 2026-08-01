export const BACKGROUND_DRAIN_GRACE_MS = 10_000;
export const BACKGROUND_TASK_STALL_TIMEOUT_MS = 45 * 60 * 1000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface BackgroundActivityTrackerOptions {
  onClose: () => void;
  graceMs?: number;
  stallTimeoutMs?: number;
  setTimeoutFn?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

export class BackgroundActivityTracker {
  private hasRunningBackgroundTasks = false;
  private everDeferred = false;
  private pendingResultSuccessful: boolean | undefined;
  private closed = false;
  private acceptedFinalSuccessfulResult = false;
  private graceTimer: TimerHandle | undefined;
  private stallTimer: TimerHandle | undefined;
  private readonly onClose: () => void;
  private readonly graceMs: number;
  private readonly stallTimeoutMs: number;
  private readonly setTimeoutFn: (callback: () => void, ms: number) => TimerHandle;
  private readonly clearTimeoutFn: (handle: TimerHandle) => void;

  constructor(options: BackgroundActivityTrackerOptions) {
    this.onClose = options.onClose;
    this.graceMs = options.graceMs ?? BACKGROUND_DRAIN_GRACE_MS;
    this.stallTimeoutMs = options.stallTimeoutMs ?? BACKGROUND_TASK_STALL_TIMEOUT_MS;
    this.setTimeoutFn =
      options.setTimeoutFn ??
      ((callback: () => void, ms: number): TimerHandle => setTimeout(callback, ms));
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((handle: TimerHandle): void => {
        clearTimeout(handle);
      });
  }

  backgroundTasksChanged(hasRunningTasks: boolean): void {
    if (this.closed) {
      return;
    }

    this.hasRunningBackgroundTasks = hasRunningTasks;
    if (hasRunningTasks) {
      this.invalidateAcceptedFinalResult();
      this.everDeferred = true;
      this.cancelGraceTimer();
      this.startStallTimer();
      return;
    }

    this.cancelStallTimer();
    this.evaluateDrain();
  }

  onTurnActivity(): void {
    if (this.closed) {
      return;
    }

    if (this.pendingResultSuccessful === undefined && !this.acceptedFinalSuccessfulResult) {
      return;
    }

    this.clearPostResultWindow();
  }

  onContinuationStarted(): void {
    if (this.closed) {
      return;
    }

    this.clearPostResultWindow();
  }

  hasPendingActivity(): boolean {
    return this.hasRunningBackgroundTasks;
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
    this.cancelStallTimer();
  }

  forceClose(): void {
    this.cancelGraceTimer();
    this.cancelStallTimer();
    this.closeWithoutAcceptingResult();
  }

  private evaluateDrain(): void {
    if (
      this.closed ||
      this.hasPendingActivity() ||
      !this.everDeferred ||
      this.pendingResultSuccessful === undefined
    ) {
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

  private startStallTimer(): void {
    this.cancelStallTimer();
    this.stallTimer = this.setTimeoutFn((): void => {
      this.stallTimer = undefined;
      if (this.closed || !this.hasRunningBackgroundTasks) {
        return;
      }

      this.hasRunningBackgroundTasks = false;
      this.startGraceTimer();
    }, this.stallTimeoutMs);
  }

  private cancelStallTimer(): void {
    if (!this.stallTimer) {
      return;
    }

    this.clearTimeoutFn(this.stallTimer);
    this.stallTimer = undefined;
  }

  private clearPostResultWindow(): void {
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
    this.cancelStallTimer();
    this.cancelGraceTimer();
    this.onClose();
  }
}
