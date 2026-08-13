import type { AgentExecutor } from './contracts.js';
import type {
  AgentInputAdapter,
  AgentInputActivity,
  AgentInputDelivery,
  AgentInputMessage,
  AgentLaunchCompletion,
  AgentLaunchHandle,
  AgentLauncher,
  AgentLaunchRequest,
  AgentPreparation,
  AgentPreparationRequest,
  AgentProviderControlResult,
  AgentProviderExitClassification,
  AgentProviderLifecycleControls,
  AgentProviderLifecycleObserver,
  AgentManagerScheduler,
  PreparedAgentExecution,
  ProcessControlId,
  ProviderThreadId,
} from './agent_manager_types.js';
import { AgentProviderForceNotAcceptedError } from './agent_manager_types.js';

/** Deterministic clock and timer implementation for lifecycle tests. */
export class FakeAgentManagerScheduler implements AgentManagerScheduler {
  private currentTime = 0;
  private nextTimerId = 1;
  private readonly timers = new Map<
    number,
    { readonly dueAt: number; readonly callback: () => void }
  >();
  private readonly cancelledTimerCallbacks: Array<() => void> = [];

  public now(): number {
    return this.currentTime;
  }

  public setTimeout(callback: () => void, delayMs: number): unknown {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError('Fake timer delay must be a finite non-negative number');
    }
    const timerId = this.nextTimerId++;
    this.timers.set(timerId, { dueAt: this.currentTime + delayMs, callback });
    return timerId;
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle !== 'number') return;
    const timer = this.timers.get(handle);
    if (timer === undefined) return;
    this.timers.delete(handle);
    this.cancelledTimerCallbacks.push(timer.callback);
  }

  public get pendingTimerCount(): number {
    return this.timers.size;
  }

  /**
   * Run callbacks that were cancelled after being scheduled.
   *
   * Real timer callbacks can already be queued when clearTimeout runs. This
   * test-only seam lets lifecycle tests prove that generation checks reject
   * those stale callbacks.
   */
  public runCancelledTimerCallbacks(): void {
    const callbacks = this.cancelledTimerCallbacks.splice(0);
    for (const callback of callbacks) callback();
  }

  public advanceBy(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError('Fake time advance must be a finite non-negative number');
    }
    this.advanceTo(this.currentTime + milliseconds);
  }

  public advanceTo(timestamp: number): void {
    if (!Number.isFinite(timestamp) || timestamp < this.currentTime) {
      throw new RangeError('Fake time must advance to a finite, non-decreasing timestamp');
    }
    this.currentTime = timestamp;
    this.runDueTimers();
  }

  private runDueTimers(): void {
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.currentTime)
        .toSorted((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (due === undefined) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value: T): void => resolvePromise?.(value),
    reject: (error: unknown): void => rejectPromise?.(error),
  };
}

function acceptedControlResult(): AgentProviderControlResult {
  return 'accepted';
}

function alreadyExitedControlResult(): AgentProviderControlResult {
  return 'already-exited';
}

type PendingProviderOperation = {
  readonly started: ReturnType<typeof deferred<void>>;
  readonly result: ReturnType<typeof deferred<AgentProviderControlResult>>;
};

/**
 * Deterministic provider lifecycle boundary. It exposes only provider-neutral
 * operations and events; tests control every resolution explicitly.
 */
export class FakeAgentProviderLifecycleControls implements AgentProviderLifecycleControls {
  private readonly observers = new Set<AgentProviderLifecycleObserver>();
  private nextGracefulOperation: PendingProviderOperation | undefined;
  private nextCloseAfterTurnOperation: PendingProviderOperation | undefined;
  private nextForcedOperation: PendingProviderOperation | undefined;
  private nextGracefulFailure: Error | undefined;
  private nextCloseAfterTurnFailure: Error | undefined;
  private nextForcedFailure: Error | undefined;
  private nextCloseAfterTurnExit:
    | {
        readonly classification: AgentProviderExitClassification;
        readonly error?: Error;
      }
    | undefined;
  private providerExited = false;

  public readonly gracefulShutdownInstructions: string[] = [];
  public gracefulShutdownCalls = 0;
  public closeAfterCurrentTurnCalls = 0;
  public forcedShutdownCalls = 0;

  public constructor() {}

  public subscribe(observer: AgentProviderLifecycleObserver): () => void {
    this.observers.add(observer);
    return (): void => {
      this.observers.delete(observer);
    };
  }

  public async requestGracefulShutdown(instruction: string): Promise<AgentProviderControlResult> {
    this.gracefulShutdownCalls += 1;
    this.gracefulShutdownInstructions.push(instruction);
    return this.resolveOperation(this.nextGracefulOperation, this.nextGracefulFailure, (): void => {
      this.nextGracefulFailure = undefined;
    });
  }

  public async requestCloseAfterCurrentTurn(): Promise<AgentProviderControlResult> {
    this.closeAfterCurrentTurnCalls += 1;
    const exit = this.nextCloseAfterTurnExit;
    this.nextCloseAfterTurnExit = undefined;
    if (exit !== undefined) this.emitExit(exit.classification, exit.error);
    return this.resolveOperation(
      this.nextCloseAfterTurnOperation,
      this.nextCloseAfterTurnFailure,
      (): void => {
        this.nextCloseAfterTurnFailure = undefined;
      }
    );
  }

  public async requestForcedShutdown(): Promise<AgentProviderControlResult> {
    this.forcedShutdownCalls += 1;
    return this.resolveOperation(this.nextForcedOperation, this.nextForcedFailure, (): void => {
      this.nextForcedFailure = undefined;
    });
  }

  public deferNextGracefulShutdown(): Promise<void> {
    if (this.nextGracefulOperation !== undefined) {
      throw new Error('A fake graceful shutdown operation is already pending');
    }
    this.nextGracefulOperation = this.createPendingOperation();
    return this.nextGracefulOperation.started.promise;
  }

  public resolveGracefulShutdown(
    result: AgentProviderControlResult = acceptedControlResult()
  ): void {
    this.resolvePendingOperation(this.nextGracefulOperation, result, 'graceful-shutdown');
  }

  public rejectGracefulShutdown(error: Error = new Error('fake graceful shutdown failure')): void {
    this.rejectPendingOperation(this.nextGracefulOperation, error, 'graceful-shutdown');
  }

  public deferNextCloseAfterCurrentTurn(): Promise<void> {
    if (this.nextCloseAfterTurnOperation !== undefined) {
      throw new Error('A fake close-after-turn operation is already pending');
    }
    this.nextCloseAfterTurnOperation = this.createPendingOperation();
    return this.nextCloseAfterTurnOperation.started.promise;
  }

  public resolveCloseAfterCurrentTurn(
    result: AgentProviderControlResult = acceptedControlResult()
  ): void {
    this.resolvePendingOperation(
      this.nextCloseAfterTurnOperation,
      result,
      'close-after-current-turn'
    );
  }

  public deferNextForcedShutdown(): Promise<void> {
    if (this.nextForcedOperation !== undefined) {
      throw new Error('A fake forced shutdown operation is already pending');
    }
    this.nextForcedOperation = this.createPendingOperation();
    return this.nextForcedOperation.started.promise;
  }

  public resolveForcedShutdown(result: AgentProviderControlResult = acceptedControlResult()): void {
    this.resolvePendingOperation(this.nextForcedOperation, result, 'forced-shutdown');
  }

  public failNextGracefulShutdown(
    error: Error = new Error('fake graceful shutdown failure')
  ): void {
    this.nextGracefulFailure = error;
  }

  public failNextCloseAfterCurrentTurn(
    error: Error = new Error('fake close-after-turn failure')
  ): void {
    this.nextCloseAfterTurnFailure = error;
  }

  /** Cause the provider to report exit synchronously during the next close request. */
  public exitDuringNextCloseAfterCurrentTurn(
    classification: AgentProviderExitClassification = 'natural',
    error?: Error
  ): void {
    this.nextCloseAfterTurnExit = Object.freeze({
      classification,
      ...(error === undefined ? {} : { error }),
    });
  }

  public failNextForcedShutdown(
    error: Error = new AgentProviderForceNotAcceptedError(
      'The fake provider did not accept forced shutdown'
    )
  ): void {
    this.nextForcedFailure = error;
  }

  public emitOutputActivity(): void {
    for (const observer of this.observers) observer.outputActivity();
  }

  public emitCompletedAssistantMessage(message: string): void {
    for (const observer of this.observers) observer.completedAssistantMessage(message);
  }

  public emitTurnComplete(): void {
    for (const observer of this.observers) observer.turnComplete();
  }

  public emitExit(
    classification: AgentProviderExitClassification = 'natural',
    error?: Error
  ): void {
    this.providerExited = true;
    for (const observer of this.observers) observer.exit(classification, error);
  }

  private createPendingOperation(): PendingProviderOperation {
    return { started: deferred<void>(), result: deferred<AgentProviderControlResult>() };
  }

  private resolveOperation(
    pendingOperation: PendingProviderOperation | undefined,
    failure: Error | undefined,
    clearFailure: () => void
  ): Promise<AgentProviderControlResult> {
    if (this.providerExited) return Promise.resolve(alreadyExitedControlResult());
    if (pendingOperation !== undefined) {
      pendingOperation.started.resolve(undefined);
      return pendingOperation.result.promise;
    }
    if (failure !== undefined) {
      clearFailure();
      return Promise.reject(failure);
    }
    return Promise.resolve(acceptedControlResult());
  }

  private resolvePendingOperation(
    operation: PendingProviderOperation | undefined,
    result: AgentProviderControlResult,
    operationName: 'graceful-shutdown' | 'close-after-current-turn' | 'forced-shutdown'
  ): void {
    if (operation === undefined) {
      throw new Error(`No fake ${operationName} operation is pending`);
    }
    operation.result.resolve(result);
    if (operationName === 'graceful-shutdown') this.nextGracefulOperation = undefined;
    if (operationName === 'close-after-current-turn') this.nextCloseAfterTurnOperation = undefined;
    if (operationName === 'forced-shutdown') this.nextForcedOperation = undefined;
  }

  private rejectPendingOperation(
    operation: PendingProviderOperation | undefined,
    error: Error,
    operationName: 'graceful-shutdown' | 'close-after-current-turn' | 'forced-shutdown'
  ): void {
    if (operation === undefined) {
      throw new Error(`No fake ${operationName} operation is pending`);
    }
    operation.result.reject(error);
    if (operationName === 'graceful-shutdown') this.nextGracefulOperation = undefined;
    if (operationName === 'close-after-current-turn') this.nextCloseAfterTurnOperation = undefined;
    if (operationName === 'forced-shutdown') this.nextForcedOperation = undefined;
  }
}

/** Deterministic input adapter for manager tests. It uses no timers. */
export class FakeAgentInputAdapter implements AgentInputAdapter {
  private readonly readyDeferred = deferred<void>();
  private readyState = false;
  private inputActivity: AgentInputActivity = 'not-ready';
  private readonly received = new Array<AgentInputMessage>();
  private readonly availabilityListeners = new Set<() => void>();
  private availabilityNotificationInsideNextDelivery = false;
  private deliveryCallCount = 0;
  private deferredDeliveryStarted: ReturnType<typeof deferred<void>> | undefined;
  private nextDelivery:
    | {
        readonly promise: Promise<AgentInputDelivery>;
        readonly resolve: (delivery: AgentInputDelivery) => void;
      }
    | undefined;
  private nextDeliveryRejection: Error | undefined;
  private persistentDeliveryRefusal: 'temporarily-unavailable' | Error | undefined;
  private postAcceptedDeliveryPause:
    | {
        readonly accepted: ReturnType<typeof deferred<void>>;
        readonly release: ReturnType<typeof deferred<void>>;
      }
    | undefined;

  public get ready(): Promise<void> {
    return this.readyDeferred.promise;
  }

  public get isReady(): boolean {
    return this.readyState;
  }

  public get activity(): AgentInputActivity {
    return this.inputActivity;
  }

  public get receivedMessages(): readonly AgentInputMessage[] {
    return Object.freeze([...this.received]);
  }

  public get deliveryCalls(): number {
    return this.deliveryCallCount;
  }

  public onAvailabilityChange(listener: () => void): () => void {
    this.availabilityListeners.add(listener);
    return (): void => {
      this.availabilityListeners.delete(listener);
    };
  }

  private notifyAvailabilityChange(): void {
    for (const listener of this.availabilityListeners) {
      listener();
    }
  }

  public markReady(): void {
    this.readyState = true;
    if (this.inputActivity === 'not-ready') {
      this.inputActivity = 'idle';
    }
    this.readyDeferred.resolve(undefined);
    this.notifyAvailabilityChange();
  }

  public setActiveAccepting(): void {
    this.inputActivity = 'active';
    this.notifyAvailabilityChange();
  }

  public setTemporarilyUnavailable(): void {
    this.inputActivity = 'temporarily-unavailable';
    this.notifyAvailabilityChange();
  }

  public setIdle(): void {
    this.inputActivity = 'idle';
    this.notifyAvailabilityChange();
  }

  /** Make the next provider delivery emit an availability notification synchronously. */
  public notifyAvailabilityChangeInsideNextDelivery(): void {
    this.availabilityNotificationInsideNextDelivery = true;
  }

  /** Reject exactly one provider delivery, then return to normal delivery behavior. */
  public rejectNextDelivery(error: Error = new Error('fake delivery failure')): void {
    if (this.nextDeliveryRejection !== undefined) {
      throw new Error('A fake delivery rejection is already configured');
    }
    this.nextDeliveryRejection = error;
  }

  /** Keep reporting delivery availability while refusing every provider call. */
  public setPersistentTemporarilyUnavailable(): void {
    this.persistentDeliveryRefusal = 'temporarily-unavailable';
  }

  /** Keep reporting delivery availability while rejecting every provider call. */
  public setPersistentDeliveryRejection(
    error: Error = new Error('fake persistent delivery failure')
  ): void {
    this.persistentDeliveryRefusal = error;
  }

  /** Stop the persistent refusal; tests should emit a real availability change after this. */
  public clearPersistentDeliveryRefusal(): void {
    this.persistentDeliveryRefusal = undefined;
  }

  /** Hold the next accepted delivery until the test explicitly resolves it. */
  public deferNextDelivery(): Promise<void> {
    if (this.nextDelivery !== undefined) {
      throw new Error('A fake delivery is already deferred');
    }
    this.deferredDeliveryStarted = deferred<void>();
    let resolveDelivery: (delivery: AgentInputDelivery) => void = () => undefined;
    const promise = new Promise<AgentInputDelivery>((resolve) => {
      resolveDelivery = resolve;
    });
    this.nextDelivery = { promise, resolve: resolveDelivery };
    return this.deferredDeliveryStarted.promise;
  }

  public resolveNextDelivery(delivery: AgentInputDelivery = 'steered'): void {
    const nextDelivery = this.nextDelivery;
    if (nextDelivery === undefined) {
      throw new Error('No fake delivery is deferred');
    }
    this.nextDelivery = undefined;
    nextDelivery.resolve(delivery);
  }

  /** Pause after the next successful delivery has been recorded. */
  public pauseAfterNextAcceptedDelivery(): {
    readonly accepted: Promise<void>;
    release(): void;
  } {
    if (this.postAcceptedDeliveryPause !== undefined) {
      throw new Error('A post-acceptance delivery pause is already configured');
    }
    const accepted = deferred<void>();
    const release = deferred<void>();
    this.postAcceptedDeliveryPause = { accepted, release };
    return {
      accepted: accepted.promise,
      release: (): void => release.resolve(undefined),
    };
  }

  public deliver(message: AgentInputMessage): AgentInputDelivery | Promise<AgentInputDelivery> {
    this.deliveryCallCount += 1;
    if (this.availabilityNotificationInsideNextDelivery) {
      this.availabilityNotificationInsideNextDelivery = false;
      this.notifyAvailabilityChange();
    }
    if (!this.readyState || this.inputActivity === 'temporarily-unavailable') {
      return 'temporarily-unavailable';
    }
    if (this.persistentDeliveryRefusal === 'temporarily-unavailable') {
      return 'temporarily-unavailable';
    }
    if (this.persistentDeliveryRefusal instanceof Error) {
      return Promise.reject(this.persistentDeliveryRefusal);
    }
    const rejection = this.nextDeliveryRejection;
    if (rejection !== undefined) {
      this.nextDeliveryRejection = undefined;
      return Promise.reject(rejection);
    }
    const deferredDelivery = this.nextDelivery;
    if (deferredDelivery !== undefined) {
      this.deferredDeliveryStarted?.resolve(undefined);
      this.deferredDeliveryStarted = undefined;
      return deferredDelivery.promise.then((delivery) => this.finishDelivery(message, delivery));
    }
    return this.finishDelivery(
      message,
      this.inputActivity === 'idle' ? 'started-idle-turn' : 'steered'
    );
  }

  private finishDelivery(
    message: AgentInputMessage,
    delivery: AgentInputDelivery
  ): AgentInputDelivery | Promise<AgentInputDelivery> {
    if (delivery === 'temporarily-unavailable') {
      return delivery;
    }
    this.received.push(Object.freeze({ ...message }));
    if (delivery === 'started-idle-turn') {
      this.inputActivity = 'active';
    }
    const pause = this.postAcceptedDeliveryPause;
    if (pause !== undefined) {
      this.postAcceptedDeliveryPause = undefined;
      pause.accepted.resolve(undefined);
      return pause.release.promise.then(() => delivery);
    }
    return delivery;
  }

  public async release(): Promise<void> {
    this.inputActivity = 'not-ready';
    this.notifyAvailabilityChange();
  }
}

export interface FakeAgentLaunch {
  readonly request: AgentLaunchRequest;
  readonly handle: FakeAgentLaunchHandle;
}

export type FakeAgentPreparationFactory = (
  request: AgentPreparationRequest
) => PreparedAgentExecution;

/** Deterministic preparation boundary with explicit failure injection. */
export class FakeAgentPreparer implements AgentPreparation {
  public readonly requests: AgentPreparationRequest[] = [];
  private nextPreparationError: Error | undefined;

  public constructor(private readonly factory: FakeAgentPreparationFactory) {}

  public setNextPreparationFailure(error: Error = new Error('fake preparation failure')): void {
    this.nextPreparationError = error;
  }

  public async prepare(request: AgentPreparationRequest): Promise<PreparedAgentExecution> {
    if (this.nextPreparationError !== undefined) {
      const error = this.nextPreparationError;
      this.nextPreparationError = undefined;
      throw error;
    }
    this.requests.push(Object.freeze({ ...request }));
    return this.factory(request);
  }
}

/** A launch handle with explicit readiness and completion controls. */
export class FakeAgentLaunchHandle implements AgentLaunchHandle {
  private readonly readyDeferred = deferred<void>();
  private readonly completionDeferred = deferred<AgentLaunchCompletion>();
  private released = false;
  private releaseError: Error | undefined;
  private releaseCalls = 0;
  private releaseGate: ReturnType<typeof deferred<void>> | undefined;
  public readonly lifecycle: FakeAgentProviderLifecycleControls;

  public constructor(
    _agentId: string,
    public readonly executor: AgentExecutor,
    public readonly processLabel: AgentLaunchRequest['processLabel'],
    public readonly input: FakeAgentInputAdapter,
    public readonly processControlId: ProcessControlId,
    public readonly providerThreadId: ProviderThreadId
  ) {
    this.lifecycle = new FakeAgentProviderLifecycleControls();
  }

  public get ready(): Promise<void> {
    return this.readyDeferred.promise;
  }

  public get completion(): Promise<AgentLaunchCompletion> {
    return this.completionDeferred.promise;
  }

  public get isReleased(): boolean {
    return this.released;
  }

  public get releaseCount(): number {
    return this.releaseCalls;
  }

  public markReady(): void {
    this.readyDeferred.resolve(undefined);
  }

  public failReady(error: Error = new Error('fake readiness failure')): void {
    this.readyDeferred.reject(error);
  }

  public complete(completion: AgentLaunchCompletion = {}): void {
    this.completionDeferred.resolve(completion);
  }

  public setReleaseFailure(error: Error = new Error('fake release failure')): void {
    this.releaseError = error;
  }

  public deferRelease(): void {
    if (this.releaseGate !== undefined) {
      throw new Error('Fake release is already deferred');
    }
    this.releaseGate = deferred<void>();
  }

  public resolveRelease(): void {
    const releaseGate = this.releaseGate;
    if (releaseGate === undefined) {
      throw new Error('Fake release is not deferred');
    }
    this.releaseGate = undefined;
    releaseGate.resolve(undefined);
  }

  public async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.releaseCalls += 1;
    this.released = true;
    await this.releaseGate?.promise;
    await this.input.release?.();
    if (this.releaseError !== undefined) {
      const error = this.releaseError;
      this.releaseError = undefined;
      throw error;
    }
  }
}

/** A deterministic launcher that records requests and never starts a provider. */
export class FakeAgentLauncher implements AgentLauncher {
  public readonly launches: FakeAgentLaunch[] = [];
  private nextId = 1;
  private nextLaunchError: Error | undefined;
  private nextReadinessError: Error | undefined;
  private nextReleaseError: Error | undefined;
  private nextReleasePending = false;
  private launchWaiter = deferred<FakeAgentLaunch>();

  public waitForNextLaunch(): Promise<FakeAgentLaunch> {
    return this.launchWaiter.promise;
  }

  public setNextLaunchFailure(error: Error = new Error('fake launch failure')): void {
    this.nextLaunchError = error;
  }

  public setNextReadinessFailure(error: Error = new Error('fake readiness failure')): void {
    this.nextReadinessError = error;
  }

  public setNextReleaseFailure(error: Error = new Error('fake release failure')): void {
    this.nextReleaseError = error;
  }

  public setNextReleasePending(): void {
    this.nextReleasePending = true;
  }

  public async launch(request: AgentLaunchRequest): Promise<FakeAgentLaunchHandle> {
    if (this.nextLaunchError !== undefined) {
      const error = this.nextLaunchError;
      this.nextLaunchError = undefined;
      throw error;
    }
    const sequence = this.nextId++;
    const input = new FakeAgentInputAdapter();
    const handle = new FakeAgentLaunchHandle(
      request.identity.id,
      request.identity.executor,
      request.processLabel,
      input,
      `fake-process-${sequence}` as ProcessControlId,
      `fake-thread-${sequence}` as ProviderThreadId
    );
    const launch = Object.freeze({ request, handle });
    this.launches.push(launch);
    this.launchWaiter.resolve(launch);
    this.launchWaiter = deferred<FakeAgentLaunch>();
    if (this.nextReleaseError !== undefined) {
      handle.setReleaseFailure(this.nextReleaseError);
      this.nextReleaseError = undefined;
    }
    if (this.nextReleasePending) {
      handle.deferRelease();
      this.nextReleasePending = false;
    }
    if (this.nextReadinessError !== undefined) {
      const error = this.nextReadinessError;
      this.nextReadinessError = undefined;
      handle.failReady(error);
    }
    return handle;
  }
}
