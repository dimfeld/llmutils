import type {
  AgentInputActivity,
  AgentInputAdapter,
  AgentInputDelivery,
  AgentInputMessage,
} from './agent_manager_types.js';
import { validateAgentInputAdapter } from './agent_manager_types.js';

/**
 * An input adapter that can be connected to a provider after the manager is
 * created. The root manager uses this while the orchestrator provider is still
 * being prepared, and reconnects it for each root execution turn.
 */
export class DeferredAgentInputAdapter implements AgentInputAdapter {
  private delegate: AgentInputAdapter | undefined;
  private unsubscribeDelegate: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;

  public constructor() {
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  public get ready(): Promise<void> {
    return this.readyPromise;
  }

  public get isReady(): boolean {
    return this.delegate?.isReady ?? false;
  }

  public get activity(): AgentInputActivity {
    return this.delegate?.activity ?? 'not-ready';
  }

  public bind(delegate: AgentInputAdapter): void {
    validateAgentInputAdapter(delegate);
    this.unsubscribeDelegate?.();
    this.delegate = delegate;
    this.resolveReady();
    this.unsubscribeDelegate = delegate.onAvailabilityChange(() => {
      this.notifyAvailabilityChange();
    });
    this.notifyAvailabilityChange();
    void delegate.ready.then(
      () => this.notifyAvailabilityChange(),
      () => this.notifyAvailabilityChange()
    );
  }

  public unbind(delegate?: AgentInputAdapter): void {
    if (delegate !== undefined && this.delegate !== delegate) return;
    this.unsubscribeDelegate?.();
    this.unsubscribeDelegate = undefined;
    this.delegate = undefined;
    this.notifyAvailabilityChange();
  }

  public deliver(message: AgentInputMessage): AgentInputDelivery | Promise<AgentInputDelivery> {
    return this.delegate?.deliver(message) ?? 'temporarily-unavailable';
  }

  public onAvailabilityChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public async release(): Promise<void> {
    const delegate = this.delegate;
    this.unbind();
    await delegate?.release?.();
  }

  private notifyAvailabilityChange(): void {
    for (const listener of this.listeners) listener();
  }
}

export interface CallbackAgentInputAdapterOptions {
  readonly onDeliver: (
    message: AgentInputMessage
  ) => AgentInputDelivery | Promise<AgentInputDelivery>;
  readonly initialActivity?: Extract<AgentInputActivity, 'active' | 'idle'>;
}

/** Small provider-side adapter for a callback-backed input path. */
export class CallbackAgentInputAdapter implements AgentInputAdapter {
  private readonly listeners = new Set<() => void>();
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private readyState = false;
  private activityState: AgentInputActivity = 'not-ready';
  private released = false;

  public constructor(private readonly options: CallbackAgentInputAdapterOptions) {
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  public get ready(): Promise<void> {
    return this.readyPromise;
  }

  public get isReady(): boolean {
    return this.readyState;
  }

  public get activity(): AgentInputActivity {
    return this.activityState;
  }

  public markReady(activity: Extract<AgentInputActivity, 'active' | 'idle'> = 'active'): void {
    if (this.released) return;
    this.readyState = true;
    this.activityState = activity;
    this.resolveReady();
    this.notifyAvailabilityChange();
  }

  public setActivity(activity: AgentInputActivity): void {
    if (this.released) return;
    this.activityState = activity;
    this.notifyAvailabilityChange();
  }

  public deliver(message: AgentInputMessage): AgentInputDelivery | Promise<AgentInputDelivery> {
    if (!this.readyState || this.released || this.activityState === 'temporarily-unavailable') {
      return 'temporarily-unavailable';
    }
    return this.options.onDeliver(message);
  }

  public onAvailabilityChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.readyState = false;
    this.activityState = 'temporarily-unavailable';
    this.notifyAvailabilityChange();
  }

  public start(): void {
    this.markReady(this.options.initialActivity ?? 'active');
  }

  private notifyAvailabilityChange(): void {
    for (const listener of this.listeners) listener();
  }
}
