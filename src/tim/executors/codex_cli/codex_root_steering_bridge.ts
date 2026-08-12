import { debugLog } from '../../../logging.js';
import {
  CallbackAgentInputAdapter,
  type DeferredAgentInputAdapter,
} from '../../agent_messaging/agent_input_adapter.js';
import type { AgentInputMessage } from '../../agent_messaging/agent_manager_types.js';
import { formatAgentInputForProvider } from '../../agent_messaging/provider_input.js';
import type { CodexAppServerConnection } from './app_server_connection.js';

const ROOT_STEERING_TAIL_WAIT_MS = 1_000;

export interface CodexRootSteeringBridgeOptions {
  readonly orchestratorInputAdapter: DeferredAgentInputAdapter;
  readonly connection: CodexAppServerConnection;
  readonly threadId: () => string;
  readonly turnId: () => string | undefined;
  readonly isAttemptActive: () => boolean;
  readonly closeConnection: () => Promise<void>;
}

/**
 * Binds the root AgentManager input to Codex turn/steer.
 *
 * The provider can finish a turn while a steer request is in flight. The
 * serialized tail keeps those requests ordered, while the bounded wait keeps
 * executor cleanup from hanging on a provider request that never answers.
 */
export class CodexRootSteeringBridge {
  private readonly adapter: CallbackAgentInputAdapter;
  private steeringTail: Promise<void> = Promise.resolve();
  private steeringEpoch = 0;
  private readonly pendingDeliveryCancellations = new Set<
    (delivery: 'temporarily-unavailable') => void
  >();
  private started = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  public constructor(private readonly options: CodexRootSteeringBridgeOptions) {
    this.adapter = new CallbackAgentInputAdapter({
      onDeliver: (message: AgentInputMessage) => this.enqueueSteer(message),
    });
  }

  public start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.adapter.start();
    this.setTemporarilyUnavailable();
    this.options.orchestratorInputAdapter.bind(this.adapter);
  }

  public setActive(): void {
    if (!this.closed) this.adapter.setActivity('active');
  }

  public setTemporarilyUnavailable(): void {
    if (!this.closed) this.adapter.setActivity('temporarily-unavailable');
  }

  public async waitForPending(closeConnection = false): Promise<void> {
    const tail = this.steeringTail;
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        resolve();
      }, ROOT_STEERING_TAIL_WAIT_MS);
    });

    try {
      await Promise.race([tail, timeout]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }

    if (!timedOut) return;

    // turn/steer is a provider request, not an AgentManager shutdown
    // operation. A provider that accepts a request just as its turn ends may
    // never answer it, so do not let executor cleanup wait forever.
    debugLog(`Codex root steering request did not settle within ${ROOT_STEERING_TAIL_WAIT_MS}ms`);
    this.steeringEpoch += 1;
    for (const cancel of this.pendingDeliveryCancellations) {
      cancel('temporarily-unavailable');
    }
    this.pendingDeliveryCancellations.clear();
    this.steeringTail = Promise.resolve();
    if (closeConnection && this.options.connection.isAlive) {
      try {
        await this.options.closeConnection();
      } catch (error) {
        debugLog('Failed to close Codex after an unanswered root steering request:', error);
      }
    }
  }

  public async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = (async (): Promise<void> => {
      this.closed = true;
      this.adapter.setActivity('temporarily-unavailable');
      await this.waitForPending(true);
      this.options.orchestratorInputAdapter.unbind(this.adapter);
      await this.adapter.release();
    })();
    return this.closePromise;
  }

  private enqueueSteer(message: AgentInputMessage): Promise<'steered' | 'temporarily-unavailable'> {
    const epoch = this.steeringEpoch;
    let cancelDelivery!: (delivery: 'temporarily-unavailable') => void;
    const cancellation = new Promise<'temporarily-unavailable'>((resolve) => {
      cancelDelivery = resolve;
    });
    this.pendingDeliveryCancellations.add(cancelDelivery);

    const steering = this.steeringTail.then(async () => {
      if (epoch !== this.steeringEpoch) return 'temporarily-unavailable' as const;
      const turnId = this.options.turnId();
      if (
        !this.options.isAttemptActive() ||
        turnId === undefined ||
        !this.options.connection.isAlive
      ) {
        return 'temporarily-unavailable' as const;
      }

      try {
        await this.options.connection.turnSteer({
          threadId: this.options.threadId(),
          input: [{ type: 'text', text: formatAgentInputForProvider(message) }],
          expectedTurnId: turnId,
        });
        if (epoch !== this.steeringEpoch) return 'temporarily-unavailable' as const;
        return 'steered' as const;
      } catch (error) {
        debugLog('Failed to send root turn/steer input:', error);
        return 'temporarily-unavailable' as const;
      }
    });
    this.steeringTail = steering.then(
      () => undefined,
      () => undefined
    );
    return Promise.race([steering, cancellation]).finally(() => {
      this.pendingDeliveryCancellations.delete(cancelDelivery);
    });
  }
}

export { ROOT_STEERING_TAIL_WAIT_MS };
