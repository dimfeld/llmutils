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
  ProcessControlId,
  ProviderThreadId,
} from './agent_manager_types.js';

function deferred<T>(): {
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

/** Deterministic input adapter for manager tests. It uses no timers. */
export class FakeAgentInputAdapter implements AgentInputAdapter {
  private readonly readyDeferred = deferred<void>();
  private readyState = false;
  private inputActivity: AgentInputActivity = 'not-ready';
  private readonly received = new Array<AgentInputMessage>();

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

  public markReady(): void {
    this.readyState = true;
    if (this.inputActivity === 'not-ready') {
      this.inputActivity = 'idle';
    }
    this.readyDeferred.resolve(undefined);
  }

  public setActiveAccepting(): void {
    this.inputActivity = 'active';
  }

  public setTemporarilyUnavailable(): void {
    this.inputActivity = 'temporarily-unavailable';
  }

  public setIdle(): void {
    this.inputActivity = 'idle';
  }

  public deliver(message: AgentInputMessage): AgentInputDelivery {
    if (!this.readyState || this.inputActivity === 'temporarily-unavailable') {
      return 'temporarily-unavailable';
    }
    this.received.push(Object.freeze({ ...message }));
    if (this.inputActivity === 'idle') {
      this.inputActivity = 'active';
      return 'started-idle-turn';
    }
    return 'steered';
  }

  public async release(): Promise<void> {
    this.inputActivity = 'not-ready';
  }
}

export interface FakeAgentLaunch {
  readonly request: AgentLaunchRequest;
  readonly handle: FakeAgentLaunchHandle;
}

/** A launch handle with explicit readiness and completion controls. */
export class FakeAgentLaunchHandle implements AgentLaunchHandle {
  private readonly readyDeferred = deferred<void>();
  private readonly completionDeferred = deferred<AgentLaunchCompletion>();
  private released = false;

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

  public markReady(): void {
    this.readyDeferred.resolve(undefined);
  }

  public complete(completion: AgentLaunchCompletion = {}): void {
    this.completionDeferred.resolve(completion);
  }

  public async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    await this.input.release?.();
  }
}

/** A deterministic launcher that records requests and never starts a provider. */
export class FakeAgentLauncher implements AgentLauncher {
  public readonly launches: FakeAgentLaunch[] = [];
  private nextId = 1;
  private nextLaunchError: Error | undefined;

  public setNextLaunchFailure(error: Error = new Error('fake launch failure')): void {
    this.nextLaunchError = error;
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
    this.launches.push(Object.freeze({ request, handle }));
    return handle;
  }
}
