import { debugLog, sendStructured } from '../../../logging';
import type { StructuredMessage } from '../../../logging/structured_messages.js';
import {
  AgentProviderControlError,
  type AgentInputActivity,
  type AgentInputAdapter,
  type AgentInputDelivery,
  type AgentInputMessage,
  type AgentProviderControlResult,
  type AgentProviderExitClassification,
  type AgentProviderLifecycleControls,
  type AgentProviderLifecycleObserver,
  type ProcessControlId,
  type ProviderThreadId,
} from '../../agent_messaging/agent_manager_types.js';
import { formatAgentInputForProvider } from '../../agent_messaging/provider_input.js';
import { createAppServerFormatter } from './app_server_format.js';
import { normalizeCodexAppServerNotification } from './app_server_notifications.js';
import type { CodexPersistentAgentLaunchOptions } from './persistent_codex_session.js';
import {
  CODEX_PERSISTENT_AGENT_MODE,
  type CodexPersistentAgentCompletion,
  type CodexPersistentAgentLaunchHandle,
  type CodexPersistentAgentState,
} from './persistent_agent_contract.js';
import {
  PersistentCodexSessionRuntime,
  type PersistentCodexRuntimeCallbacks,
} from './persistent_codex_session_runtime.js';

interface PersistentCodexTurn {
  readonly generation: number;
  turnId?: string;
  settled: boolean;
  assistantMessage?: string;
}

type DeliveryIntent =
  | { readonly kind: 'ordinary' }
  | { readonly kind: 'graceful'; readonly turnAccepted: (turn: PersistentCodexTurn) => void };

export class PersistentCodexInputAdapter implements AgentInputAdapter {
  private readyState = false;
  private currentActivity: AgentInputActivity = 'not-ready';
  private readonly availabilityListeners = new Set<() => void>();
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: unknown) => void) | undefined;

  public readonly readyPromise = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });

  public constructor(
    private readonly onDeliver: (
      message: AgentInputMessage
    ) => AgentInputDelivery | Promise<AgentInputDelivery>,
    private readonly onRelease: () => Promise<void>
  ) {
    void this.readyPromise.catch(() => undefined);
  }

  public get ready(): Promise<void> {
    return this.readyPromise;
  }

  public get isReady(): boolean {
    return this.readyState;
  }

  public get activity(): AgentInputActivity {
    return this.currentActivity;
  }

  public markReady(): void {
    if (this.readyState) return;
    this.readyState = true;
    this.currentActivity = 'active';
    this.resolveReady?.();
    this.notifyAvailabilityChange();
  }

  public failReady(error: unknown): void {
    this.rejectReady?.(error);
  }

  public markIdle(): void {
    if (!this.readyState) return;
    this.currentActivity = 'idle';
    this.notifyAvailabilityChange();
  }

  public markActive(): void {
    if (!this.readyState) return;
    this.currentActivity = 'active';
    this.notifyAvailabilityChange();
  }

  public markTemporarilyUnavailable(): void {
    if (!this.readyState) return;
    this.currentActivity = 'temporarily-unavailable';
    this.notifyAvailabilityChange();
  }

  public markNotReady(): void {
    this.readyState = false;
    this.currentActivity = 'not-ready';
    this.notifyAvailabilityChange();
  }

  public deliver(message: AgentInputMessage): AgentInputDelivery | Promise<AgentInputDelivery> {
    return this.onDeliver(message);
  }

  public onAvailabilityChange(listener: () => void): () => void {
    this.availabilityListeners.add(listener);
    return (): void => {
      this.availabilityListeners.delete(listener);
    };
  }

  public async release(): Promise<void> {
    await this.onRelease();
  }

  private notifyAvailabilityChange(): void {
    for (const listener of this.availabilityListeners) listener();
  }
}

export class PersistentCodexTurnController {
  private readonly completionDeferred = createDeferred<CodexPersistentAgentCompletion>();
  private readonly input: PersistentCodexInputAdapter;
  private readonly observers = new Set<AgentProviderLifecycleObserver>();
  private readonly formatter: ReturnType<typeof createAppServerFormatter>;
  private state: CodexPersistentAgentState = 'starting';
  private currentTurn: PersistentCodexTurn | undefined;
  private nextTurnGeneration = 0;
  private lastCompletedAssistantMessage: string | undefined;
  private closeAfterCurrentTurn = false;
  private closeAfterTurnGeneration: number | undefined;
  private gracefulShutdownRequest: Promise<AgentProviderControlResult> | undefined;
  private forcedShutdownRequest: Promise<AgentProviderControlResult> | undefined;
  private forcedShutdownRequested = false;
  private expectedClosingClassification: AgentProviderExitClassification | undefined;
  private readonly stateWaiters = new Set<() => void>();
  private readonly interruptedTurnGenerations = new Set<number>();
  private closePromise: Promise<void> | undefined;
  private exitNotified = false;
  private deliveryInFlight = false;

  public constructor(
    private readonly options: CodexPersistentAgentLaunchOptions,
    private readonly runtime: PersistentCodexSessionRuntime
  ) {
    this.formatter = createAppServerFormatter(options.model);
    this.input = new PersistentCodexInputAdapter(
      (message) => this.deliver(message),
      () => this.close('forced')
    );
    this.observers.add(options.lifecycleObserver);
  }

  public get providerState(): CodexPersistentAgentState {
    return this.state;
  }

  public start(): CodexPersistentAgentLaunchHandle {
    const handle = this.createHandle();
    void this.initialize().catch((error: unknown) => {
      debugLog('Persistent Codex startup failed:', error);
    });
    return handle;
  }

  public async initialize(): Promise<void> {
    try {
      const callbacks: PersistentCodexRuntimeCallbacks = {
        onNotification: (method, params): void => this.handleNotification(method, params),
        onUnexpectedExit: (error): void => {
          void this.failProvider(error);
        },
        onGracefulEnd: (): void => {
          void this.close('graceful');
        },
      };
      await this.runtime.initialize(callbacks);
      const initialTurn = this.beginTurn();
      await this.startTurn(initialTurn, this.options.prompt);
      this.throwIfClosing();
      this.input.markReady();
      this.syncInputActivity();
    } catch (error) {
      const startupError = toError(error);
      this.input.failReady(startupError);
      try {
        await this.close('failed', startupError);
      } catch (cleanupError) {
        debugLog('Persistent Codex startup cleanup failed:', cleanupError);
      }
    }
  }

  public async close(
    classification: AgentProviderExitClassification = 'natural',
    error?: Error
  ): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;

    const effectiveClassification =
      this.expectedClosingClassification === 'forced'
        ? 'forced'
        : classification === 'failed'
          ? 'failed'
          : (this.expectedClosingClassification ?? classification);
    this.expectedClosingClassification = effectiveClassification;
    this.state = effectiveClassification === 'forced' ? 'stopping-forced' : 'terminal';
    if (!this.input.isReady) {
      this.input.failReady(
        error ?? new Error('Persistent Codex provider closed before startup completed.')
      );
    }
    this.input.markNotReady();
    this.closePromise = this.finishClose(effectiveClassification, error);
    this.notifyStateWaiters();
    return this.closePromise;
  }

  private async finishClose(
    classification: AgentProviderExitClassification,
    error?: Error
  ): Promise<void> {
    const cleanupError = await this.runtime.close(classification, error);
    const finalError = combineCloseErrors(error, cleanupError);
    this.state = 'terminal';
    if (!this.exitNotified) {
      this.exitNotified = true;
      this.notifyObservers((observer) => observer.exit(classification, finalError));
    }
    this.completionDeferred.resolve({
      ...(finalError === undefined ? {} : { error: finalError }),
      ...(this.lastCompletedAssistantMessage === undefined
        ? {}
        : {
            lastCompletedAssistantMessage: this.lastCompletedAssistantMessage,
            finalMessage: this.lastCompletedAssistantMessage,
          }),
    });
    this.observers.clear();
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.closePromise !== undefined) return;
    const notification = normalizeCodexAppServerNotification(method, params);
    if (
      notification.threadId !== undefined &&
      notification.threadId !== this.runtime.currentThreadId
    ) {
      return;
    }

    const message = this.formatter.handleNotification(method, params);
    sendFormattedStructured(message.structured);
    if (this.isProviderActivity(notification)) {
      this.notifyObservers((observer) => observer.outputActivity());
    }

    const turn = this.currentTurn;
    const belongsToCurrentTurn =
      turn !== undefined &&
      (notification.turnId === undefined ||
        turn.turnId === undefined ||
        notification.turnId === turn.turnId);
    if (belongsToCurrentTurn && turn !== undefined && !turn.settled && message.agentMessage) {
      turn.assistantMessage = message.agentMessage;
    }

    if (method === 'turn/started') {
      if (turn === undefined || turn.settled) return;
      if (notification.turnId !== undefined) {
        if (turn.turnId !== undefined && turn.turnId !== notification.turnId) {
          void this.failProvider(
            new Error(`Codex reported conflicting turn IDs for generation ${turn.generation}.`)
          );
          return;
        }
        turn.turnId = notification.turnId;
      }
      if (this.forcedShutdownRequested) {
        void this.interruptTurn(turn);
      } else if (this.closeAfterTurnGeneration === turn.generation) {
        this.setState('stopping-gracefully');
      } else {
        this.setState('running-active');
      }
      return;
    }

    if (
      method === 'turn/completed' ||
      (method === 'thread/status/changed' && notification.threadStatusType === 'idle')
    ) {
      this.completeTurn(notification.turnStatus, notification.turnId);
    }
  }

  private deliver(message: AgentInputMessage): Promise<AgentInputDelivery> {
    if (this.deliveryInFlight) return Promise.resolve('temporarily-unavailable');
    this.deliveryInFlight = true;
    return this.attemptDelivery(formatAgentInputForProvider(message), { kind: 'ordinary' }).finally(
      () => {
        this.deliveryInFlight = false;
        this.syncInputActivity();
        this.notifyStateWaiters();
      }
    );
  }

  /** One serialized active-steer or idle-start transition for all input. */
  private async attemptDelivery(
    content: string,
    intent: DeliveryIntent
  ): Promise<AgentInputDelivery> {
    if (!this.input.isReady || this.closePromise !== undefined || !this.runtime.isAlive) {
      return 'temporarily-unavailable';
    }
    if (
      this.state === 'starting' ||
      this.state === 'running-active-starting' ||
      this.state === 'finishing' ||
      this.state === 'stopping-gracefully' ||
      this.state === 'stopping-forced' ||
      this.state === 'terminal'
    ) {
      return 'temporarily-unavailable';
    }

    const connection = this.runtime.currentConnection;
    const threadId = this.runtime.currentThreadId;
    if (connection === undefined || threadId === undefined) return 'temporarily-unavailable';

    if (this.state === 'running-active') {
      const turn = this.currentTurn;
      if (turn === undefined || turn.settled || turn.turnId === undefined) {
        return 'temporarily-unavailable';
      }
      this.prepareIntent(intent, turn);
      this.input.markTemporarilyUnavailable();
      try {
        await connection.turnSteer({
          threadId,
          input: [{ type: 'text', text: content }],
          expectedTurnId: turn.turnId,
        });
        if (this.closePromise !== undefined || !this.runtime.isAlive) {
          return 'temporarily-unavailable';
        }
        return 'steered';
      } catch (error) {
        this.rollbackIntent(intent, turn);
        if (!this.runtime.isAlive && this.closePromise === undefined) {
          await this.failProvider(toError(error));
          throw error;
        }
        if (intent.kind === 'ordinary') return 'temporarily-unavailable';
        throw error;
      } finally {
        this.syncInputActivity();
      }
    }

    if (this.state === 'running-idle') {
      const turn = this.beginTurn();
      this.prepareIntent(intent, turn);
      try {
        await this.startTurn(turn, content);
        if (this.closePromise !== undefined || !this.runtime.isAlive) {
          return 'temporarily-unavailable';
        }
        return 'started-idle-turn';
      } catch (error) {
        this.rollbackIntent(intent, turn);
        throw error;
      } finally {
        this.syncInputActivity();
      }
    }
    return 'temporarily-unavailable';
  }

  private prepareIntent(intent: DeliveryIntent, turn: PersistentCodexTurn): void {
    if (intent.kind !== 'graceful') return;
    this.closeAfterCurrentTurn = true;
    this.closeAfterTurnGeneration = turn.generation;
    this.expectedClosingClassification = 'graceful';
    intent.turnAccepted(turn);
  }

  private rollbackIntent(intent: DeliveryIntent, turn: PersistentCodexTurn): void {
    if (intent.kind !== 'graceful' || this.closePromise !== undefined) return;
    if (this.closeAfterTurnGeneration === turn.generation) {
      this.closeAfterTurnGeneration = undefined;
      this.closeAfterCurrentTurn = false;
      this.expectedClosingClassification = undefined;
      this.setState(this.currentTurn === turn && !turn.settled ? 'running-active' : 'running-idle');
    }
  }

  private beginTurn(): PersistentCodexTurn {
    if (this.currentTurn !== undefined && !this.currentTurn.settled) {
      throw new Error('Codex persistent session already has an active turn');
    }
    const turn: PersistentCodexTurn = {
      generation: ++this.nextTurnGeneration,
      settled: false,
    };
    this.currentTurn = turn;
    this.setState('running-active-starting');
    return turn;
  }

  private async startTurn(turn: PersistentCodexTurn, content: string): Promise<void> {
    const connection = this.runtime.currentConnection;
    const threadId = this.runtime.currentThreadId;
    if (connection === undefined || threadId === undefined) {
      throw new Error('Codex persistent session is not ready to start a turn');
    }
    this.runtime.markTurnStart(connection);
    try {
      const turnResult = await connection.turnStart({
        threadId,
        input: [{ type: 'text', text: content }],
        model: this.options.model,
        effort: this.options.reasoningLevel ?? 'medium',
      });
      if (turn.turnId !== undefined && turn.turnId !== turnResult.turnId) {
        throw new Error(`Codex reported conflicting turn IDs for generation ${turn.generation}.`);
      }
      turn.turnId = turnResult.turnId;
      if (this.forcedShutdownRequested) {
        await this.interruptTurn(turn);
        if (this.currentTurn === turn) {
          turn.settled = true;
          this.currentTurn = undefined;
        }
        return;
      }
      if (turn.settled) {
        if (this.currentTurn === turn) this.currentTurn = undefined;
        return;
      }
      if (this.currentTurn === turn) {
        this.setState(
          this.closeAfterTurnGeneration === turn.generation
            ? 'stopping-gracefully'
            : 'running-active'
        );
      }
    } catch (error) {
      if (this.forcedShutdownRequested || this.closePromise !== undefined) {
        if (this.currentTurn === turn) {
          turn.settled = true;
          this.currentTurn = undefined;
        }
        return;
      }
      if (!turn.settled) {
        if (this.currentTurn === turn) this.currentTurn = undefined;
        await this.failProvider(toError(error));
      }
      throw error;
    } finally {
      this.runtime.clearTurnStart(connection);
    }
  }

  private completeTurn(status: string, turnId: string | undefined): void {
    const turn = this.currentTurn;
    if (turn === undefined || turn.settled) return;
    if (turnId !== undefined) {
      if (turn.turnId !== undefined && turn.turnId !== turnId) {
        void this.failProvider(
          new Error(`Codex reported conflicting turn IDs for generation ${turn.generation}.`)
        );
        return;
      }
      turn.turnId = turnId;
    }
    if (this.forcedShutdownRequested || this.state === 'stopping-forced') {
      turn.settled = true;
      this.currentTurn = undefined;
      void this.close('forced');
      return;
    }
    if (status.toLowerCase() !== 'completed') {
      turn.settled = true;
      this.currentTurn = undefined;
      void this.failProvider(new Error(`Codex persistent turn ended with status "${status}".`));
      return;
    }

    turn.settled = true;
    const shouldCloseAfterTurn =
      this.closeAfterCurrentTurn &&
      (this.closeAfterTurnGeneration === undefined ||
        this.closeAfterTurnGeneration === turn.generation);
    this.currentTurn = undefined;
    this.setStateWithoutAvailability('running-idle');
    if (turn.assistantMessage !== undefined && turn.assistantMessage.trim().length > 0) {
      this.lastCompletedAssistantMessage = turn.assistantMessage;
      this.notifyObservers((observer) =>
        observer.completedAssistantMessage(turn.assistantMessage!)
      );
    }
    this.notifyObservers((observer) => observer.turnComplete());

    const shouldCloseAfterCallbacks =
      this.closeAfterCurrentTurn &&
      (this.closeAfterTurnGeneration === undefined ||
        this.closeAfterTurnGeneration === turn.generation);
    if (shouldCloseAfterTurn || shouldCloseAfterCallbacks) {
      void this.close(this.expectedClosingClassification ?? 'graceful');
    } else {
      this.input.markIdle();
    }
  }

  private setState(state: CodexPersistentAgentState): void {
    this.state = state;
    this.syncInputActivity();
    this.notifyStateWaiters();
  }

  private setStateWithoutAvailability(state: CodexPersistentAgentState): void {
    this.state = state;
    this.notifyStateWaiters();
  }

  private syncInputActivity(): void {
    if (!this.input.isReady) return;
    if (this.state === 'running-active') return this.input.markActive();
    if (this.state === 'running-idle') return this.input.markIdle();
    this.input.markTemporarilyUnavailable();
  }

  private isProviderActivity(
    notification: ReturnType<typeof normalizeCodexAppServerNotification>
  ): boolean {
    if (
      notification.lowerMethod.startsWith('account/') ||
      notification.lowerMethod === 'thread/tokenusage/updated' ||
      notification.lowerMethod.startsWith('thread/tokenusage/')
    ) {
      return false;
    }
    if (notification.lowerMethod.startsWith('item/') && notification.isUserMessageItem) {
      return false;
    }
    return (
      notification.lowerMethod === 'thread/started' ||
      notification.lowerMethod.startsWith('thread/status/') ||
      notification.lowerMethod.startsWith('turn/') ||
      notification.lowerMethod.startsWith('item/') ||
      notification.lowerMethod.startsWith('codex/event/') ||
      notification.lowerMethod.startsWith('llm/item/')
    );
  }

  private async failProvider(error: Error): Promise<void> {
    if (this.closePromise !== undefined) return;
    await this.close('failed', error);
  }

  private createHandle(): CodexPersistentAgentLaunchHandle {
    const getProviderState = (): CodexPersistentAgentState => this.state;
    const getProcessControlId = (): ProcessControlId | undefined =>
      this.runtime.processControlId as ProcessControlId | undefined;
    const getProviderThreadId = (): ProviderThreadId | undefined =>
      this.runtime.providerThreadId as ProviderThreadId | undefined;
    const lifecycle: AgentProviderLifecycleControls = {
      requestGracefulShutdown: (instruction): Promise<AgentProviderControlResult> =>
        this.requestGracefulShutdown(instruction),
      requestCloseAfterCurrentTurn: (): Promise<AgentProviderControlResult> =>
        this.requestCloseAfterCurrentTurn(),
      requestForcedShutdown: (): Promise<AgentProviderControlResult> =>
        this.requestForcedShutdown(),
      subscribe: (observer): (() => void) => {
        this.observers.add(observer);
        return (): void => {
          this.observers.delete(observer);
        };
      },
    };
    return {
      mode: CODEX_PERSISTENT_AGENT_MODE,
      executor: 'codex-cli',
      processLabel: this.options.processLabel,
      get providerState(): CodexPersistentAgentState {
        return getProviderState();
      },
      input: this.input,
      ready: this.input.ready,
      completion: this.completionDeferred.promise,
      lifecycle,
      get processControlId(): ProcessControlId | undefined {
        return getProcessControlId();
      },
      get providerThreadId(): ProviderThreadId | undefined {
        return getProviderThreadId();
      },
      release: async (): Promise<void> => {
        await this.close('forced');
      },
    };
  }

  private requestCloseAfterCurrentTurn(): Promise<AgentProviderControlResult> {
    if (this.state === 'terminal' || this.forcedShutdownRequested)
      return Promise.resolve('already-exited');
    if (this.closeAfterCurrentTurn) return Promise.resolve('accepted');
    this.closeAfterCurrentTurn = true;
    this.expectedClosingClassification = 'graceful';
    if (this.currentTurn !== undefined && !this.currentTurn.settled) {
      this.closeAfterTurnGeneration = this.currentTurn.generation;
      this.setState('finishing');
    } else {
      this.setState('finishing');
    }
    return Promise.resolve('accepted');
  }

  private requestGracefulShutdown(instruction: string): Promise<AgentProviderControlResult> {
    if (this.state === 'terminal' || this.forcedShutdownRequested)
      return Promise.resolve('already-exited');
    if (this.gracefulShutdownRequest !== undefined) return this.gracefulShutdownRequest;
    this.gracefulShutdownRequest = this.deliverGracefulInstruction(instruction).catch((error) => {
      this.gracefulShutdownRequest = undefined;
      throw error;
    });
    return this.gracefulShutdownRequest;
  }

  private requestForcedShutdown(): Promise<AgentProviderControlResult> {
    if (this.state === 'terminal') return Promise.resolve('already-exited');
    if (this.forcedShutdownRequest !== undefined) return this.forcedShutdownRequest;
    this.forcedShutdownRequested = true;
    this.expectedClosingClassification = 'forced';
    this.state = 'stopping-forced';
    this.input.markNotReady();
    this.notifyStateWaiters();
    this.forcedShutdownRequest = (async (): Promise<AgentProviderControlResult> => {
      const turn = this.currentTurn;
      if (turn !== undefined && !turn.settled) void this.interruptTurn(turn);
      await this.close('forced');
      return 'accepted';
    })();
    return this.forcedShutdownRequest;
  }

  private async deliverGracefulInstruction(
    instruction: string
  ): Promise<AgentProviderControlResult> {
    for (;;) {
      await this.waitForDeliveryIdle();
      if (
        this.state === 'terminal' ||
        this.forcedShutdownRequested ||
        this.closePromise !== undefined
      ) {
        return 'already-exited';
      }
      this.throwIfProviderDeadDuringGracefulShutdown();
      const result = await this.runDeliveryAttempt(instruction, {
        kind: 'graceful',
        turnAccepted: (turn): void => {
          this.setState('stopping-gracefully');
          this.closeAfterTurnGeneration = turn.generation;
        },
      });
      if (result !== 'temporarily-unavailable') return 'accepted';
      await this.waitForStableInputState();
    }
  }

  private async runDeliveryAttempt(
    content: string,
    intent: DeliveryIntent
  ): Promise<AgentInputDelivery> {
    await this.waitForDeliveryIdle();
    if (this.deliveryInFlight) return 'temporarily-unavailable';
    this.deliveryInFlight = true;
    try {
      return await this.attemptDelivery(content, intent);
    } catch (error) {
      if (intent.kind === 'graceful') {
        throw new AgentProviderControlError(
          'graceful-shutdown',
          `Codex persistent graceful shutdown could not deliver its final instruction: ${toError(error).message}`,
          { cause: error }
        );
      }
      throw error;
    } finally {
      this.deliveryInFlight = false;
      this.syncInputActivity();
      this.notifyStateWaiters();
    }
  }

  private async waitForDeliveryIdle(): Promise<void> {
    while (this.deliveryInFlight && !this.closePromise) {
      await new Promise<void>((resolve) => this.stateWaiters.add(resolve));
    }
  }

  private async waitForStableInputState(): Promise<void> {
    while (!this.isStableInputState()) {
      if (this.closePromise !== undefined || this.forcedShutdownRequested) return;
      this.throwIfProviderDeadDuringGracefulShutdown();
      await new Promise<void>((resolve) => this.stateWaiters.add(resolve));
    }
  }

  private isStableInputState(): boolean {
    if (!this.input.isReady || this.closePromise !== undefined || !this.runtime.isAlive) {
      return false;
    }
    if (
      this.runtime.currentConnection === undefined ||
      this.runtime.currentThreadId === undefined
    ) {
      return false;
    }
    if (this.state === 'running-idle') return true;
    return (
      this.state === 'running-active' &&
      this.currentTurn !== undefined &&
      !this.currentTurn.settled &&
      this.currentTurn.turnId !== undefined
    );
  }

  private throwIfProviderDeadDuringGracefulShutdown(): void {
    if (
      this.closePromise !== undefined ||
      this.runtime.currentConnection === undefined ||
      this.runtime.isAlive
    ) {
      return;
    }
    const error = new AgentProviderControlError(
      'graceful-shutdown',
      'Codex persistent provider is no longer alive while delivering its graceful shutdown instruction.'
    );
    void this.failProvider(error);
    throw error;
  }

  private async interruptTurn(turn: PersistentCodexTurn): Promise<void> {
    const connection = this.runtime.currentConnection ?? this.runtime.currentTurnStartConnection;
    const threadId = this.runtime.currentThreadId;
    if (!connection?.isAlive || threadId === undefined || turn.turnId === undefined) return;
    if (this.interruptedTurnGenerations.has(turn.generation)) return;
    this.interruptedTurnGenerations.add(turn.generation);
    try {
      await connection.turnInterrupt({ threadId, turnId: turn.turnId });
    } catch (error) {
      debugLog('Failed to interrupt Codex persistent turn during forced shutdown:', error);
    }
  }

  private notifyStateWaiters(): void {
    const waiters = [...this.stateWaiters];
    this.stateWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private notifyObservers(callback: (observer: AgentProviderLifecycleObserver) => void): void {
    for (const observer of this.observers) {
      try {
        callback(observer);
      } catch (error) {
        debugLog('Persistent Codex lifecycle callback failed:', error);
      }
    }
  }

  private throwIfClosing(): void {
    if (this.closePromise !== undefined) {
      throw new Error('Persistent Codex provider closed during startup.');
    }
  }
}

function sendFormattedStructured(
  structured: StructuredMessage | StructuredMessage[] | undefined
): void {
  if (structured === undefined) return;
  if (Array.isArray(structured)) {
    for (const message of structured) sendStructured(message);
    return;
  }
  sendStructured(structured);
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

function combineCloseErrors(
  primary: Error | undefined,
  cleanup: Error | undefined
): Error | undefined {
  if (primary === undefined) return cleanup;
  if (cleanup === undefined || cleanup === primary) return primary;
  const combined = new Error(
    `${primary.message}; persistent Codex cleanup also failed: ${cleanup.message}`
  );
  combined.cause = primary;
  return combined;
}
