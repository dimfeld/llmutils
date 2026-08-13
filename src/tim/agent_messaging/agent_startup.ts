import { AgentManagerError, type AgentLaunchHandle } from './agent_manager_types.js';
import type { SessionRegistrationHandle } from './session_runtime.js';
import type {
  AgentDirectory,
  AgentReservation,
  SubagentDirectoryRecord,
} from './agent_directory.js';

interface Cancellation {
  readonly promise: Promise<AgentManagerError>;
  cancel(error: AgentManagerError): void;
}

function createCancellation(): Cancellation {
  let resolveCancellation: ((error: AgentManagerError) => void) | undefined;
  let cancelled = false;
  const promise = new Promise<AgentManagerError>((resolve) => {
    resolveCancellation = resolve;
  });
  return {
    promise,
    cancel: (error: AgentManagerError): void => {
      if (!cancelled) {
        cancelled = true;
        resolveCancellation?.(error);
      }
    },
  };
}

function managerClosedError(): AgentManagerError {
  return new AgentManagerError(
    'manager_closed',
    'The agent manager was closed while the agent was starting'
  );
}

/** Tracks resources that may resolve after a start has been cancelled. */
class AgentStartOperation {
  public mailbox: SessionRegistrationHandle | undefined;
  public handle: AgentLaunchHandle | undefined;
  public pendingMailboxRegistration: Promise<SessionRegistrationHandle> | undefined;
  public pendingHandleLaunch: Promise<AgentLaunchHandle> | undefined;
  public cleanupRequested = false;

  private readonly cancellation = createCancellation();
  private cancellationError: AgentManagerError | undefined;
  private mailboxDeregisterPromise: Promise<void> | undefined;
  private handleReleasePromise: Promise<void> | undefined;
  private readonly lateCleanupPromises = new Set<Promise<void>>();
  private lateCleanupErrors: unknown[] = [];
  private lateCleanupGeneration = 0;
  private closeCleanupRequested = false;

  public constructor(
    public readonly record: SubagentDirectoryRecord,
    public readonly reservation: AgentReservation,
    private readonly directory: AgentDirectory
  ) {}

  public ensureActive(): void {
    if (this.cancellationError !== undefined) {
      throw this.cancellationError;
    }
    if (this.cleanupRequested || this.directory.getRecord(this.record.id) !== this.record) {
      throw managerClosedError();
    }
  }

  /** Abort the active startup boundary with a classified manager error. */
  public cancel(error: AgentManagerError): void {
    this.cleanupRequested = true;
    this.cancellationError ??= error;
    this.cancellation.cancel(error);
  }

  public async awaitBoundary<T>(operation: Promise<T>): Promise<T> {
    if (this.cancellationError !== undefined) {
      throw this.cancellationError;
    }
    const result = await Promise.race([
      operation.then((value: T) => ({ kind: 'value' as const, value })),
      this.cancellation.promise.then((error) => ({ kind: 'cancelled' as const, error })),
    ]);
    if (result.kind === 'cancelled') {
      throw result.error;
    }
    // A provider exit can cancel the operation in the same microtask turn as
    // readiness. Preserve that classified startup error instead of converting
    // it to the generic manager-closed error in the next boundary check.
    if (this.cancellationError !== undefined) {
      throw this.cancellationError;
    }
    return result.value;
  }

  public async awaitResource<T>(
    operation: Promise<T>,
    attach: (value: T) => void,
    track: (operation: Promise<T> | undefined) => void
  ): Promise<T> {
    let attached = false;
    const tracked = operation.then((value: T): T => {
      if (!attached) {
        attached = true;
        attach(value);
      }
      return value;
    });
    track(tracked);
    void tracked.then(
      (): void => track(undefined),
      (): void => track(undefined)
    );
    return this.awaitBoundary(tracked);
  }

  public attachMailbox(mailbox: SessionRegistrationHandle): void {
    this.mailbox = mailbox;
    this.record.registration = mailbox.registration;
    this.record.mailbox = mailbox;
    if (this.cleanupRequested) {
      this.trackLateCleanup(this.deregisterMailbox());
    }
  }

  public attachHandle(handle: AgentLaunchHandle): void {
    this.handle = handle;
    this.record.launchHandle = handle;
    this.record.processControlId = handle.processControlId;
    this.record.providerThreadId = handle.providerThreadId;
    if (this.cleanupRequested) {
      this.trackLateCleanup(this.releaseHandle());
    }
  }

  public async rollback(): Promise<void> {
    this.cleanupRequested = true;
    this.cancellation.cancel(managerClosedError());
    this.record.launchHandle = undefined;
    this.record.launchReady = false;
    this.record.mailbox = undefined;
    this.record.registration = undefined;

    // A close-cancelled operation must not wait for an unresolved provider
    // preparation or launch promise. Late resources are attached and released
    // by attachMailbox()/attachHandle() after cleanupRequested is set.
    if (!this.closeCleanupRequested) {
      await Promise.allSettled(
        [this.pendingMailboxRegistration, this.pendingHandleLaunch].filter(
          (
            operation
          ): operation is Promise<SessionRegistrationHandle> | Promise<AgentLaunchHandle> =>
            operation !== undefined
        )
      );
    }
    const handleRelease = this.releaseHandle();
    void handleRelease.catch(() => undefined);
    const mailboxCleanup = this.deregisterMailbox();
    await mailboxCleanup.catch(() => undefined);
    this.reservation.release();
    // Provider cleanup can outlive the failed StartAgent operation. The name
    // and capacity become reusable once the mailbox generation is gone.
  }

  public async cleanupForClose(): Promise<void> {
    this.closeCleanupRequested = true;
    this.cleanupRequested = true;
    this.cancellation.cancel(managerClosedError());
    let firstError: unknown;
    // Pending registration, launch, and readiness promises have no common
    // cancellation API. Do not wait for them here; their tracked continuations
    // clean up a late resource when it resolves.
    try {
      await this.deregisterMailbox();
    } catch (error) {
      firstError ??= error;
    }
    this.reservation.release();
    try {
      await this.releaseHandle();
    } catch (error) {
      firstError ??= error;
    }
    try {
      await this.waitForLateCleanup();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) throw firstError;
  }

  /**
   * Wait for cleanup of resources that resolved after cancellation.
   *
   * This does not await the original preparation or launch boundary. It only
   * waits for cleanup promises for resources that have actually attached,
   * with one event-loop drain to collect a resource that resolves during
   * teardown.
   */
  public async waitForLateCleanup(): Promise<void> {
    let observedGeneration = this.lateCleanupGeneration;
    for (;;) {
      const pending = [...this.lateCleanupPromises];
      if (pending.length > 0) {
        await Promise.allSettled(pending);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (
        pending.length === 0 &&
        this.lateCleanupPromises.size === 0 &&
        observedGeneration === this.lateCleanupGeneration
      ) {
        break;
      }
      observedGeneration = this.lateCleanupGeneration;
    }
    const firstError = this.lateCleanupErrors[0];
    this.lateCleanupErrors = [];
    if (firstError !== undefined) throw firstError;
  }

  private trackLateCleanup(cleanup: Promise<void>): void {
    const tracked = cleanup.then(
      (): void => undefined,
      (error: unknown): void => {
        this.lateCleanupErrors.push(error);
      }
    );
    this.lateCleanupPromises.add(tracked);
    this.lateCleanupGeneration += 1;
    void tracked.then(() => {
      this.lateCleanupPromises.delete(tracked);
      this.lateCleanupGeneration += 1;
    });
  }

  private deregisterMailbox(): Promise<void> {
    if (this.mailboxDeregisterPromise !== undefined) {
      return this.mailboxDeregisterPromise;
    }
    if (this.mailbox === undefined) return Promise.resolve();
    this.mailboxDeregisterPromise = this.mailbox.deregister();
    return this.mailboxDeregisterPromise;
  }

  private releaseHandle(): Promise<void> {
    if (this.handleReleasePromise !== undefined) {
      return this.handleReleasePromise;
    }
    if (this.handle?.release === undefined) return Promise.resolve();
    const handle = this.handle;
    this.handleReleasePromise = Promise.resolve().then(() => handle.release?.());
    return this.handleReleasePromise;
  }
}

/** Owns all startup operations so AgentManager does not own cancellation state. */
export class AgentStartupTracker {
  private readonly operations = new Map<string, AgentStartOperation>();

  public constructor(private readonly directory: AgentDirectory) {}

  public create(
    record: SubagentDirectoryRecord,
    reservation: AgentReservation
  ): AgentStartOperation {
    const operation = new AgentStartOperation(record, reservation, this.directory);
    this.operations.set(record.id, operation);
    return operation;
  }

  public finish(operation: AgentStartOperation): void {
    if (this.operations.get(operation.record.id) === operation) {
      this.operations.delete(operation.record.id);
    }
  }

  public values(): readonly AgentStartOperation[] {
    return [...this.operations.values()];
  }

  public findByRecord(record: SubagentDirectoryRecord): AgentStartOperation | undefined {
    return this.operations.get(record.id)?.record === record
      ? this.operations.get(record.id)
      : undefined;
  }
}
