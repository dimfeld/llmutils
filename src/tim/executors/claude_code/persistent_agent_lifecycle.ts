import type { FileSink } from 'bun';
import type {
  AgentInputActivity,
  AgentInputAdapter,
  AgentInputDelivery,
  AgentInputMessage,
} from '../../agent_messaging/agent_manager_types.js';
import { BackgroundActivityTracker } from './background_activity_tracker.ts';
import type { FormattedClaudeMessage } from './format.ts';
import {
  ClaudePersistentInputClosedError,
  PersistentClaudeInputWriter,
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

  public constructor(options: PersistentClaudeTurnControllerOptions) {
    this.options = options;
    this.writer = new PersistentClaudeInputWriter({
      stdin: options.stdin,
      debugLog: options.debugLog,
      onWriteFailure: (error: unknown): void => {
        this.handleWriteFailure(error);
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
    return this.writer.activity;
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
    return this.writer.onAvailabilityChange(listener);
  }

  /** Start the initial turn. This operation is idempotent. */
  public start(): void {
    if (this.started || this.isClosedOrTerminal()) return;
    this.started = true;

    if (this.options.initialPrompt === undefined) {
      this.writer.markReady('idle');
      this.stateValue = 'idle';
      return;
    }

    const generation = this.beginTurn();
    this.writer.markReady('active');
    this.handleWriteResult(this.writer.writeUserMessage(this.options.initialPrompt), generation);
  }

  /**
   * Deliver one manager message. Idle is claimed before the writer can await
   * an asynchronous FileSink write, so two callers cannot start two turns.
   */
  public deliver(message: AgentInputMessage): AgentInputDelivery | Promise<AgentInputDelivery> {
    return this.deliverContent(message.content);
  }

  /** Deliver content from a provider-owned control path without a fake source. */
  public deliverContent(content: string): AgentInputDelivery | Promise<AgentInputDelivery> {
    this.assertAcceptingInput();

    let generation: number | undefined;
    if (this.stateValue === 'idle' && !this.writer.isWriteInProgress) {
      generation = this.beginTurn();
    }

    const deliveryGeneration = this.turnGenerationValue;
    const result = this.writer.deliverContent(content);
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
      this.stateValue = 'finish-after-result';
    }

    this.currentTracker.onResultMessage(resultWasSuccessful);
    if (
      !this.closeAfterCurrentResultValue &&
      !this.turnSettled &&
      this.currentTracker.hasPendingResult()
    ) {
      this.stateValue = 'result-pending-background';
      this.writer.markProviderState('result-pending-background');
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
    this.stateValue = closeKind === 'graceful' ? 'graceful-stop-active' : 'finish-after-result';
    this.writer.markProviderState(this.stateValue);
  }

  /** Close stdin immediately for a provider/session-wide end request. */
  public forceCloseInputNow(): void {
    if (this.isClosedOrTerminal()) return;
    this.stateValue = 'closing';
    this.currentTracker?.cancel();
    this.writer.close();
  }

  /** Record provider exit so late mailbox messages are rejected. */
  public markProviderExited(): void {
    if (this.isTerminal()) return;
    this.currentTracker?.cancel();
    this.stateValue = 'exited';
    this.writer.markProviderState('exited');
  }

  /** Record a provider/input failure and make the adapter terminal. */
  public markProviderFailed(error: unknown): void {
    if (this.isTerminal()) return;
    this.currentTracker?.cancel();
    this.stateValue = 'failed';
    this.writer.fail(error);
  }

  /** Idempotently cancel timers and prevent any later input delivery. */
  public cleanup(): void {
    if (this.isClosedOrTerminal()) {
      this.currentTracker?.cancel();
      return;
    }
    this.currentTracker?.cancel();
    this.stateValue = 'closing';
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
    this.stateValue = 'active';
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
    result: AgentInputDelivery | Promise<AgentInputDelivery>,
    deliveryGeneration: number,
    generation: number | undefined
  ): AgentInputDelivery | Promise<AgentInputDelivery> {
    if (isPromiseLike(result)) {
      return result.then(
        (delivery: AgentInputDelivery): AgentInputDelivery => {
          this.handleAcceptedDelivery(deliveryGeneration, generation, delivery);
          return delivery;
        },
        (error: unknown): never => {
          this.rollbackFailedIdleTurn(generation);
          throw error;
        }
      );
    }
    this.handleAcceptedDelivery(deliveryGeneration, generation, result);
    return result;
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
      this.writer.markProviderState('active');
    }
  }

  private handleWriteResult(
    result: ReturnType<PersistentClaudeInputWriter['writeUserMessage']>,
    generation: number
  ): void {
    if (isPromiseLike(result)) {
      void result.then(
        (outcome): void => {
          if (outcome.status !== 'accepted') this.rollbackFailedIdleTurn(generation);
        },
        (): void => {
          this.rollbackFailedIdleTurn(generation);
        }
      );
      return;
    }
    if (result.status !== 'accepted') {
      this.rollbackFailedIdleTurn(generation);
    }
  }

  private rollbackUnacceptedIdleTurn(
    generation: number | undefined,
    delivery: AgentInputDelivery
  ): void {
    if (generation === undefined || delivery !== 'temporarily-unavailable') return;
    if (this.turnGenerationValue !== generation || this.writer.state !== 'idle') return;
    this.currentTracker?.cancel();
    this.turnSettled = true;
    this.stateValue = 'idle';
  }

  private rollbackFailedIdleTurn(generation: number | undefined): void {
    if (generation === undefined || this.turnGenerationValue !== generation) return;
    if (this.isClosedOrTerminal()) return;
    this.currentTracker?.cancel();
    this.turnSettled = true;
    this.stateValue = this.writer.state === 'idle' ? 'idle' : 'failed';
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
      this.stateValue = 'closing';
      this.writer.close();
    } else {
      this.stateValue = 'idle';
      this.writer.markProviderState('idle');
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
    this.stateValue = 'active';
    this.writer.markProviderState('active');
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
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}
