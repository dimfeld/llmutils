import { AgentManagerError, type AgentLaunchHandle } from './agent_manager_types.js';
import type { SessionRegistrationHandle } from './session_runtime.js';
import type {
  AgentDirectory,
  AgentReservation,
  SubagentDirectoryRecord,
} from './agent_directory.js';

interface Cancellation {
  readonly promise: Promise<void>;
  cancel(): void;
}

function createCancellation(): Cancellation {
  let resolveCancellation: (() => void) | undefined;
  let cancelled = false;
  const promise = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  return {
    promise,
    cancel: (): void => {
      if (!cancelled) {
        cancelled = true;
        resolveCancellation?.();
      }
    },
  };
}

/** Tracks resources that may resolve after a start has been cancelled. */
class AgentStartOperation {
  public mailbox: SessionRegistrationHandle | undefined;
  public handle: AgentLaunchHandle | undefined;
  public pendingMailboxRegistration: Promise<SessionRegistrationHandle> | undefined;
  public pendingHandleLaunch: Promise<AgentLaunchHandle> | undefined;
  public cleanupRequested = false;

  private readonly cancellation = createCancellation();
  private mailboxDeregisterPromise: Promise<void> | undefined;
  private handleReleasePromise: Promise<void> | undefined;

  public constructor(
    public readonly record: SubagentDirectoryRecord,
    public readonly reservation: AgentReservation,
    private readonly directory: AgentDirectory
  ) {}

  public ensureActive(): void {
    if (this.cleanupRequested || this.directory.getRecord(this.record.id) !== this.record) {
      throw new AgentManagerError(
        'manager_closed',
        'The agent manager was closed while the agent was starting'
      );
    }
  }

  public async awaitBoundary<T>(operation: Promise<T>): Promise<T> {
    const result = await Promise.race([
      operation.then((value: T) => ({ kind: 'value' as const, value })),
      this.cancellation.promise.then(() => ({ kind: 'cancelled' as const })),
    ]);
    if (result.kind === 'cancelled') {
      throw new AgentManagerError(
        'manager_closed',
        'The agent manager was closed while the agent was starting'
      );
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
      void this.deregisterMailbox().catch(() => undefined);
    }
  }

  public attachHandle(handle: AgentLaunchHandle): void {
    this.handle = handle;
    this.record.launchHandle = handle;
    this.record.processControlId = handle.processControlId;
    this.record.providerThreadId = handle.providerThreadId;
    if (this.cleanupRequested) {
      void this.releaseHandle().catch(() => undefined);
    }
  }

  public async rollback(): Promise<void> {
    this.cleanupRequested = true;
    this.cancellation.cancel();
    this.record.launchHandle = undefined;
    this.record.launchReady = false;
    this.record.mailbox = undefined;
    this.record.registration = undefined;

    // Await any operation that may still attach a late resource before
    // releasing the name. This prevents a replacement generation racing it.
    await Promise.allSettled(
      [this.pendingMailboxRegistration, this.pendingHandleLaunch].filter(
        (operation): operation is Promise<SessionRegistrationHandle> | Promise<AgentLaunchHandle> =>
          operation !== undefined
      )
    );
    const handleRelease = this.releaseHandle();
    void handleRelease.catch(() => undefined);
    const mailboxCleanup = this.deregisterMailbox();
    await mailboxCleanup.catch(() => undefined);
    this.reservation.release();
    // Provider cleanup can outlive the failed StartAgent operation. The name
    // and capacity become reusable once the mailbox generation is gone.
  }

  public async cleanupForClose(): Promise<void> {
    this.cleanupRequested = true;
    this.cancellation.cancel();
    let firstError: unknown;
    const pendingResults = await Promise.allSettled(
      [this.pendingMailboxRegistration, this.pendingHandleLaunch].filter(
        (operation): operation is Promise<SessionRegistrationHandle> | Promise<AgentLaunchHandle> =>
          operation !== undefined
      )
    );
    for (const result of pendingResults) {
      if (result.status === 'rejected') firstError ??= result.reason;
    }
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
    if (firstError !== undefined) throw firstError;
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
}
