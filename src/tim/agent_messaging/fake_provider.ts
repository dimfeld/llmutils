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
  PreparedAgentExecution,
  ProcessControlId,
  ProviderThreadId,
} from './agent_manager_types.js';

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
  ): AgentInputDelivery {
    if (delivery === 'temporarily-unavailable') {
      return delivery;
    }
    this.received.push(Object.freeze({ ...message }));
    if (delivery === 'started-idle-turn') {
      this.inputActivity = 'active';
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

  public constructor(
    public readonly executor: AgentExecutor,
    public readonly processLabel: AgentLaunchRequest['processLabel'],
    public readonly input: FakeAgentInputAdapter,
    public readonly processControlId: ProcessControlId,
    public readonly providerThreadId: ProviderThreadId
  ) {}

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
