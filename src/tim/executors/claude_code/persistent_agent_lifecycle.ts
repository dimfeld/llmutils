import type { FileSink } from 'bun';
import type {
  AgentInputActivity,
  AgentInputAdapter,
  AgentInputDelivery,
  AgentInputMessage,
} from '../../agent_messaging/agent_manager_types.js';
import { formatAgentInputForProvider } from '../../agent_messaging/provider_input.js';
import { BackgroundActivityTracker } from './background_activity_tracker.ts';
import type { FormattedClaudeMessage } from './format.ts';
import {
  ClaudePersistentInputClosedError,
  PersistentClaudeInputWriter,
  type PersistentClaudeInputWriteResult,
} from './streaming_input.ts';
import type { ClaudePersistentAgentState } from './persistent_agent_contract.js';

type TimerHandle = ReturnType<typeof setTimeout>;

export interface PersistentClaudeTurnControllerOptions {
  readonly stdin: FileSink;
  readonly debugLog: (...args: unknown[]) => void;
  readonly initialPrompt?: string;
  readonly onTurnComplete?: (
    successful: boolean,
    generation: number,
    resultText: string | undefined
  ) => void;
  readonly graceMs?: number;
  readonly stallTimeoutMs?: number;
  readonly setTimeoutFn?: (callback: () => void, ms: number) => TimerHandle;
  readonly clearTimeoutFn?: (handle: TimerHandle) => void;
}

export interface PersistentClaudeTurnControllerSnapshot {
  readonly state: ClaudePersistentAgentState;
  readonly generation: number;
  readonly resultSeen: boolean;
  readonly closeAfterCurrentResult: boolean;
}

/**
 * Owns the persistent Claude turn boundary above the one serialized stdin
 * writer. The writer remains the only object that writes to stdin. This
 * controller only decides when a turn is active, settled, or closing.
 */
export class PersistentClaudeTurnController implements AgentInputAdapter {
  private readonly writer: PersistentClaudeInputWriter;
  private readonly options: PersistentClaudeTurnControllerOptions;
  private currentTracker: BackgroundActivityTracker | undefined;
  private stateValue: ClaudePersistentAgentState = 'spawning';
  private turnGenerationValue = 0;
  private turnSettled = false;
  private resultSeenValue = false;
  private resultSuccessfulValue = false;
  private resultTextValue: string | undefined;
  private closeAfterCurrentResultValue = false;
  private started = false;
  private readonly availabilityListeners = new Set<() => void>();

  public constructor(options: PersistentClaudeTurnControllerOptions) {
    this.options = options;
    this.writer = new PersistentClaudeInputWriter({
      stdin: options.stdin,
      debugLog: options.debugLog,
      onWriteFailure: (error: unknown): void => {
        this.handleWriteFailure(error);
      },
      onAvailabilityChange: (): void => {
        this.notifyAvailabilityChange();
      },
    });
  }

  public get ready(): Promise<void> {
    return this.writer.ready;
  }

  public get isReady(): boolean {
    return this.writer.isReady;
  }

  public get activity(): AgentInputActivity {
    switch (this.stateValue) {
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
    return this.stateValue;
  }

  public get generation(): number {
    return this.turnGenerationValue;
  }

  public get inputWriter(): PersistentClaudeInputWriter {
    return this.writer;
  }

  public get snapshot(): PersistentClaudeTurnControllerSnapshot {
    return {
      state: this.stateValue,
      generation: this.turnGenerationValue,
      resultSeen: this.resultSeenValue,
      closeAfterCurrentResult: this.closeAfterCurrentResultValue,
    };
  }

  public onAvailabilityChange(listener: () => void): () => void {
    this.availabilityListeners.add(listener);
    return (): void => {
      this.availabilityListeners.delete(listener);
    };
  }

  /** Start the initial turn. This operation is idempotent. */
  public start(): void {
    if (this.started || this.isClosedOrTerminal()) return;
    this.started = true;

    if (this.options.initialPrompt === undefined) {
      this.setState('idle');
      this.writer.markReady();
      return;
    }

    const generation = this.beginTurn();
    this.writer.markWritable();
    this.handleInitialWriteResult(
      this.writer.writeUserMessage(this.options.initialPrompt),
      generation
    );
  }

  /**
   * Deliver one manager message. Idle is claimed before the writer can await
   * an asynchronous FileSink write, so two callers cannot start two turns.
   */
  public deliver(message: AgentInputMessage): AgentInputDelivery | Promise<AgentInputDelivery> {
    return this.deliverContent(formatAgentInputForProvider(message));
  }

  /** Deliver content from a provider-owned control path without a fake source. */
  public deliverContent(content: string): AgentInputDelivery | Promise<AgentInputDelivery> {
    this.assertAcceptingInput();

    let generation: number | undefined;
    if (this.stateValue === 'idle' && !this.writer.isWriteInProgress) {
      generation = this.beginTurn();
    }

    const deliveryGeneration = this.turnGenerationValue;
    const result = this.writer.writeUserMessage(content);
    return this.handleDeliveryResult(result, deliveryGeneration, generation);
  }

  /** Convenience path for existing local follow-up adapters. */
  public sendContent(content: string): AgentInputDelivery | Promise<AgentInputDelivery> {
    return this.deliverContent(content);
  }

  /** Called for each complete formatted Claude lifecycle message. */
  public observeFormattedMessage(formatted: FormattedClaudeMessage): void {
    if (this.isClosedOrTerminal() || this.turnSettled || this.currentTracker === undefined) return;

    if (formatted.backgroundActivity !== undefined) {
      const { hasRunningTasks } = formatted.backgroundActivity;
      this.currentTracker.backgroundTasksChanged(hasRunningTasks);
      if (hasRunningTasks && this.resultSeenValue && !this.closeAfterCurrentResultValue) {
        this.resultTextValue = undefined;
        this.markTurnActive();
      }
      return;
    }

    if (formatted.type === 'assistant' || formatted.type === 'user') {
      const wasResultPending = this.stateValue === 'result-pending-background';
      this.currentTracker.onTurnActivity();
      if (wasResultPending && !this.closeAfterCurrentResultValue) {
        this.resultTextValue = undefined;
        this.markTurnActive();
      }
    }
  }

  /** Called when Claude emits a complete result record for the current turn. */
  public onResultMessage(resultWasSuccessful: boolean, resultText?: string): void {
    if (this.isClosedOrTerminal() || this.turnSettled || this.currentTracker === undefined) return;

    this.resultSeenValue = true;
    this.resultSuccessfulValue = resultWasSuccessful;
    this.resultTextValue = resultText;
    if (this.closeAfterCurrentResultValue) {
      this.setState('finish-after-result');
    }

    this.currentTracker.onResultMessage(resultWasSuccessful);
    if (
      !this.closeAfterCurrentResultValue &&
      !this.turnSettled &&
      this.currentTracker.hasPendingResult()
    ) {
      this.setState('result-pending-background');
    }
  }

  /**
   * Mark the current turn for close after its settled result. The flag is set
   * before any provider call or result callback can run.
   */
  public requestCloseAfterCurrentResult(closeKind: 'finish' | 'graceful' = 'finish'): void {
    if (this.isClosedOrTerminal()) return;
    if (this.closeAfterCurrentResultValue) return;
    if (
      this.currentTracker === undefined ||
      this.turnSettled ||
      (this.stateValue !== 'active' && this.stateValue !== 'result-pending-background')
    ) {
      throw new ClaudePersistentInputClosedError(
        'Claude persistent agent has no active turn to close'
      );
    }

    this.closeAfterCurrentResultValue = true;
    this.setState(closeKind === 'graceful' ? 'graceful-stop-active' : 'finish-after-result');
  }

  /** Close stdin immediately for a provider/session-wide end request. */
  public forceCloseInputNow(): void {
    if (this.isClosedOrTerminal()) return;
    this.setState('closing');
    this.currentTracker?.cancel();
    this.writer.close();
  }

  /** Record provider exit so late mailbox messages are rejected. */
  public markProviderExited(): void {
    if (this.isTerminal()) return;
    this.currentTracker?.cancel();
    this.setState('exited');
    this.writer.markProviderExited();
    this.notifyAvailabilityChange();
  }

  /** Record a provider/input failure and make the adapter terminal. */
  public markProviderFailed(error: unknown): void {
    if (this.isTerminal()) return;
    this.currentTracker?.cancel();
    this.setState('failed');
    this.writer.fail(error);
    this.notifyAvailabilityChange();
  }

  /** Idempotently cancel timers and prevent any later input delivery. */
  public cleanup(): void {
    if (this.isClosedOrTerminal()) {
      this.currentTracker?.cancel();
      return;
    }
    this.currentTracker?.cancel();
    this.setState('closing');
    this.writer.close();
  }

  public async release(): Promise<void> {
    this.cleanup();
  }

  private beginTurn(): number {
    this.currentTracker?.cancel();
    this.turnGenerationValue += 1;
    const generation = this.turnGenerationValue;
    this.turnSettled = false;
    this.resultSeenValue = false;
    this.resultSuccessfulValue = false;
    this.resultTextValue = undefined;
    this.setState('active');
    this.currentTracker = new BackgroundActivityTracker({
      onClose: (): void => {
        this.settleTurn(generation);
      },
      graceMs: this.options.graceMs,
      stallTimeoutMs: this.options.stallTimeoutMs,
      setTimeoutFn: this.options.setTimeoutFn,
      clearTimeoutFn: this.options.clearTimeoutFn,
    });
    return generation;
  }

  private handleDeliveryResult(
    result: PersistentClaudeInputWriteResult | Promise<PersistentClaudeInputWriteResult>,
    deliveryGeneration: number,
    generation: number | undefined
  ): AgentInputDelivery | Promise<AgentInputDelivery> {
    if (isPromiseLike(result)) {
      return result.then(
        (writeResult: PersistentClaudeInputWriteResult): AgentInputDelivery => {
          const delivery = this.toAgentInputDelivery(writeResult, generation);
          this.handleAcceptedDelivery(deliveryGeneration, generation, delivery);
          return delivery;
        },
        (error: unknown): never => {
          this.rollbackFailedIdleTurn(generation);
          throw error;
        }
      );
    }
    const delivery = this.toAgentInputDelivery(result, generation);
    this.handleAcceptedDelivery(deliveryGeneration, generation, delivery);
    return delivery;
  }

  private handleAcceptedDelivery(
    deliveryGeneration: number,
    claimedIdleGeneration: number | undefined,
    delivery: AgentInputDelivery
  ): void {
    if (delivery === 'temporarily-unavailable') {
      this.rollbackUnacceptedIdleTurn(claimedIdleGeneration, delivery);
      return;
    }

    if (this.turnGenerationValue === deliveryGeneration && !this.turnSettled) {
      this.currentTracker?.onContinuationStarted();
      if (this.stateValue === 'result-pending-background') {
        this.markTurnActive();
      }
      return;
    }

    // A write that started during an active turn can finish after the result
    // callback settled that turn. The record is already in the stream, so
    // attach it to one new generation instead of allowing the old result to
    // leave the controller falsely idle.
    if (
      claimedIdleGeneration === undefined &&
      deliveryGeneration === this.turnGenerationValue &&
      this.turnSettled &&
      this.stateValue === 'idle' &&
      !this.closeAfterCurrentResultValue
    ) {
      this.beginTurn();
    }
  }

  private handleInitialWriteResult(
    result: ReturnType<PersistentClaudeInputWriter['writeUserMessage']>,
    generation: number
  ): void {
    if (isPromiseLike(result)) {
      void result.then(
        (outcome): void => {
          if (outcome.status === 'accepted') {
            this.writer.markReady();
          } else {
            this.rollbackFailedIdleTurn(generation);
          }
        },
        (error: unknown): void => {
          this.markProviderFailed(error);
          this.rollbackFailedIdleTurn(generation);
        }
      );
      return;
    }
    if (result.status === 'accepted') {
      this.writer.markReady();
    } else {
      this.rollbackFailedIdleTurn(generation);
    }
  }

  private rollbackUnacceptedIdleTurn(
    generation: number | undefined,
    delivery: AgentInputDelivery
  ): void {
    if (generation === undefined || delivery !== 'temporarily-unavailable') return;
    if (this.turnGenerationValue !== generation || this.stateValue !== 'active') return;
    this.currentTracker?.cancel();
    this.turnSettled = true;
    this.setState('idle');
  }

  private rollbackFailedIdleTurn(generation: number | undefined): void {
    if (generation === undefined || this.turnGenerationValue !== generation) return;
    if (this.isClosedOrTerminal()) return;
    this.currentTracker?.cancel();
    this.turnSettled = true;
    this.setState(this.stateValue === 'idle' ? 'idle' : 'failed');
  }

  private settleTurn(generation: number): void {
    if (
      generation !== this.turnGenerationValue ||
      this.turnSettled ||
      this.isClosedOrTerminal() ||
      this.currentTracker === undefined
    ) {
      return;
    }

    this.turnSettled = true;
    if (this.closeAfterCurrentResultValue) {
      this.setState('closing');
      this.writer.close();
    } else {
      this.setState('idle');
    }

    try {
      this.options.onTurnComplete?.(this.resultSuccessfulValue, generation, this.resultTextValue);
    } catch (error) {
      this.options.debugLog('Persistent Claude turn-complete callback failed: %s', error);
    }
  }

  private markTurnActive(): void {
    if (
      this.isClosedOrTerminal() ||
      this.turnSettled ||
      this.closeAfterCurrentResultValue ||
      this.stateValue === 'active'
    ) {
      return;
    }
    this.setState('active');
  }

  private handleWriteFailure(error: unknown): void {
    if (this.isClosedOrTerminal()) return;
    this.markProviderFailed(error);
  }

  private assertAcceptingInput(): void {
    if (this.isClosedOrTerminal() || this.closeAfterCurrentResultValue) {
      throw new ClaudePersistentInputClosedError(
        'Claude persistent agent is closing and cannot accept input'
      );
    }
  }

  private isTerminal(): boolean {
    return this.stateValue === 'exited' || this.stateValue === 'failed';
  }

  private isClosedOrTerminal(): boolean {
    return this.stateValue === 'closing' || this.isTerminal();
  }

  private toAgentInputDelivery(
    result: PersistentClaudeInputWriteResult,
    claimedIdleGeneration: number | undefined
  ): AgentInputDelivery {
    switch (result.status) {
      case 'accepted':
        return claimedIdleGeneration === undefined ? 'steered' : 'started-idle-turn';
      case 'temporarily-unavailable':
        return result.status;
      case 'failed':
        throw new ClaudePersistentInputClosedError(
          'Claude persistent input is closed or failed',
          result.error === undefined ? undefined : { cause: result.error }
        );
    }
  }

  private setState(state: ClaudePersistentAgentState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.notifyAvailabilityChange();
  }

  private notifyAvailabilityChange(): void {
    for (const listener of this.availabilityListeners) {
      try {
        listener();
      } catch (error) {
        this.options.debugLog('Persistent Claude turn availability callback failed: %s', error);
      }
    }
  }
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}
