import { isNonterminalAgentLifecycleState } from './contracts.js';
import type { AgentIdentity, AgentInputAdapter } from './agent_manager_types.js';
import type { MailboxMessageRequest } from './mailbox_protocol.js';
import type { MailboxDeliveryResult } from './mailbox_server.js';
import type { AgentRegistration } from './runtime_dir.js';
import type { SessionRegistrationHandle } from './session_runtime.js';
import type { AgentDirectory, DirectoryRecord } from './agent_directory.js';

function validateInputAdapter(value: AgentInputAdapter): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.ready?.then !== 'function' ||
    typeof value.isReady !== 'boolean' ||
    !['not-ready', 'active', 'temporarily-unavailable', 'idle'].includes(value.activity) ||
    typeof value.deliver !== 'function' ||
    typeof value.onAvailabilityChange !== 'function'
  ) {
    throw new TypeError('Agent input adapter does not implement the provider-neutral contract');
  }
}

/** Owns one agent's provider input and the mailbox-to-provider drain. */
export class AgentMailboxBinding {
  private input: AgentInputAdapter | undefined;
  private receiver: SessionRegistrationHandle['receiver'] | undefined;
  private unsubscribe: (() => void) | undefined;
  private availabilityVersion = 0;
  private retryVersion: number | undefined;
  private drainPromise: Promise<void> | undefined;
  private disposed = false;

  public constructor(
    private readonly directory: AgentDirectory,
    private readonly record: DirectoryRecord
  ) {}

  public get pendingCount(): number {
    return this.receiver?.pendingCount ?? 0;
  }

  public attachMailbox(mailbox: SessionRegistrationHandle): void {
    this.receiver = mailbox.receiver;
    this.record.registration = mailbox.registration;
    this.record.mailbox = mailbox;
  }

  public bindInputAdapter(input: AgentInputAdapter): void {
    validateInputAdapter(input);
    this.unsubscribe?.();
    this.input = input;
    this.availabilityVersion += 1;
    const boundVersion = this.availabilityVersion;
    this.unsubscribe = input.onAvailabilityChange(() => {
      if (this.isCurrent()) this.noteAvailability(input);
    });
    void input.ready.then(
      (): void => {
        if (this.isCurrent() && this.availabilityVersion === boundVersion) {
          this.noteAvailability(input);
        }
      },
      (): void => undefined
    );
  }

  public markLaunchReady(): void {
    if (this.record.role === 'subagent') {
      this.record.launchReady = true;
    }
    if (this.input !== undefined) {
      this.updateRecordInputState(this.input);
    }
    this.scheduleDrain();
  }

  public deliver(
    message: MailboxMessageRequest,
    sourceRegistration: AgentRegistration
  ): Promise<MailboxDeliveryResult> {
    return this.deliverNow(message, sourceRegistration);
  }

  public scheduleDrain(): void {
    if (this.disposed || this.pendingCount === 0) return;
    if (!this.canDeliverNow()) return;
    if (this.drainPromise !== undefined) return;

    const version = this.availabilityVersion;
    let drainPromise: Promise<void>;
    drainPromise = this.drainPending()
      .catch(() => undefined)
      .finally(() => {
        if (this.drainPromise === drainPromise) {
          this.drainPromise = undefined;
          if (this.availabilityVersion !== version && this.isCurrent()) {
            this.scheduleDrain();
          }
        }
      });
    this.drainPromise = drainPromise;
  }

  /** Dispose listeners and prevent late provider callbacks from touching state. */
  public dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.input = undefined;
    this.receiver = undefined;
    this.retryVersion = undefined;
  }

  private isCurrent(): boolean {
    return !this.disposed && this.directory.getRecord(this.record.id) === this.record;
  }

  private noteAvailability(input: AgentInputAdapter): void {
    this.availabilityVersion += 1;
    this.retryVersion = undefined;
    this.updateRecordInputState(input);
    this.scheduleDrain();
  }

  private updateRecordInputState(input: AgentInputAdapter): void {
    this.record.inputActivity = input.activity;
    if (
      (this.record.role === 'orchestrator' || this.record.launchReady) &&
      input.isReady &&
      (this.record.state === 'starting' ||
        this.record.state === 'running-active' ||
        this.record.state === 'running-idle')
    ) {
      this.record.state = input.activity === 'active' ? 'running-active' : 'running-idle';
    }
  }

  private canDeliverNow(): boolean {
    const input = this.input;
    return (
      input !== undefined &&
      this.receiver !== undefined &&
      this.isCurrent() &&
      isNonterminalAgentLifecycleState(this.record.state) &&
      this.record.state !== 'finishing' &&
      this.record.state !== 'stopping' &&
      input.isReady &&
      input.activity !== 'not-ready' &&
      input.activity !== 'temporarily-unavailable' &&
      (this.record.role !== 'subagent' || this.record.launchReady)
    );
  }

  private async deliverNow(
    message: MailboxMessageRequest,
    sourceRegistration: AgentRegistration
  ): Promise<MailboxDeliveryResult> {
    if (!this.isCurrent() || !isNonterminalAgentLifecycleState(this.record.state)) {
      return 'temporarily-unavailable';
    }
    if (this.record.state === 'finishing' || this.record.state === 'stopping') {
      return 'temporarily-unavailable';
    }
    const source = this.directory.resolveTrustedSource(sourceRegistration);
    const input = this.input;
    const receiver = this.receiver;
    if (
      !this.canDeliverNow() ||
      this.drainPromise !== undefined ||
      receiver === undefined ||
      input === undefined ||
      receiver.pendingCount !== 0
    ) {
      return 'temporarily-unavailable';
    }
    const delivery = await input.deliver({
      messageId: message.requestId,
      source,
      content: message.content,
    });
    this.updateRecordInputState(input);
    if (delivery === 'temporarily-unavailable') this.scheduleRetry();
    return delivery;
  }

  private scheduleRetry(): void {
    const version = this.availabilityVersion;
    if (this.retryVersion === version) return;
    this.retryVersion = version;
    setImmediate(() => {
      if (!this.isCurrent() || this.retryVersion !== version) return;
      if (this.pendingCount === 0) {
        this.retryVersion = undefined;
        return;
      }
      this.scheduleDrain();
    });
  }

  private async drainPending(): Promise<void> {
    while (this.canDeliverNow()) {
      const receiver = this.receiver;
      const input = this.input;
      if (receiver === undefined || input === undefined) return;
      const lease = receiver.leasePending(1);
      if (lease === undefined) return;
      const entry = lease.messages[0];
      if (entry === undefined) {
        lease.acknowledge();
        return;
      }
      const source: AgentIdentity = this.directory.identityFromRegistration(
        entry.sourceRegistration
      );
      try {
        const delivery = await input.deliver({
          messageId: entry.request.requestId,
          source,
          content: entry.request.content,
        });
        if (delivery === 'temporarily-unavailable') {
          lease.requeue();
          this.scheduleRetry();
          return;
        }
        lease.acknowledge();
        this.retryVersion = undefined;
        this.updateRecordInputState(input);
      } catch {
        lease.requeue();
        return;
      }
    }
  }
}
