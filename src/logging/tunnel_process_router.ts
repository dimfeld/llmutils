import type { ServerTunnelMessage, TunnelProcessMessage } from './tunnel_protocol.js';
import {
  isProcessId,
  type ProcessId,
  type SessionProcessRegistry,
} from '../common/session_process.js';

/** A stable tunnel channel used for owner binding and targeted controls. */
export interface TunnelProcessChannel {
  readonly id: string;
  readonly connected: boolean;
  send: (message: ServerTunnelMessage) => boolean;
}

export type TunnelControlResult =
  | { ok: true; clientId: string }
  | {
      ok: false;
      reason:
        | 'unknown_executor'
        | 'not_executor'
        | 'stale_executor'
        | 'owner_not_registered'
        | 'owner_not_connected'
        | 'send_failed';
    };

function isTerminalState(state: 'starting' | 'running' | 'exited' | 'orphaned'): boolean {
  return state === 'exited' || state === 'orphaned';
}

/**
 * Owns tunnel-side process authorization, cleanup, owner binding, and control
 * routing. It never keeps a second process tree; the session registry remains
 * the only source of process state.
 */
export class TunnelProcessRouter {
  private readonly registry: SessionProcessRegistry | undefined;
  private readonly channels = new Map<string, TunnelProcessChannel>();

  constructor(registry?: SessionProcessRegistry) {
    this.registry = registry?.isActive ? registry : undefined;
  }

  registerClient(channel: TunnelProcessChannel): void {
    this.channels.set(channel.id, channel);
    this.registry?.registerOwnerChannelSender(channel.id, (executorId, requestId) =>
      channel.send({
        type: 'terminate_executor',
        executorId,
        ...(requestId ? { requestId } : {}),
      })
    );
  }

  unregisterClient(clientId: string): void {
    this.channels.delete(clientId);
    this.registry?.releaseChannel(clientId, 'remove');
  }

  /** Handles a validated process message from one tunnel client. */
  handleProcessMessage(message: TunnelProcessMessage, client: TunnelProcessChannel): boolean {
    // A tunnel without an active session registry still carries its legacy
    // output protocol. Lifecycle messages become safe no-ops in that mode.
    if (!this.registry) {
      return true;
    }

    switch (message.type) {
      case 'process_register':
        return this.registerProcess(message, client);
      case 'process_update':
        return this.updateProcess(message.processId, message, client);
      case 'process_exit':
        return this.exitProcess(message.processId, message, client);
      case 'process_remove':
        return this.removeProcess(message.processId, message.subtree ?? true, client);
      case 'terminate_executor_result':
        return this.receiveTerminationResult(message.executorId, message, client);
    }
  }

  bindOwnerToClient(ownerProcessId: ProcessId, clientId: string): boolean {
    const client = this.channels.get(clientId);
    return Boolean(
      client?.connected && this.registry?.bindOwnerToChannel(ownerProcessId, clientId)
    );
  }

  sendExecutorTermination(executorId: ProcessId, requestId?: string): TunnelControlResult {
    const registry = this.registry;
    if (!registry || !isProcessId(executorId)) {
      return { ok: false, reason: 'unknown_executor' };
    }

    const executor = registry.get(executorId);
    if (!executor) {
      return { ok: false, reason: 'unknown_executor' };
    }
    if (executor.kind !== 'executor') {
      return { ok: false, reason: 'not_executor' };
    }
    if (isTerminalState(executor.state)) {
      return { ok: false, reason: 'stale_executor' };
    }

    const ownerProcessId = executor.ownerProcessId;
    if (!ownerProcessId) {
      return { ok: false, reason: 'owner_not_registered' };
    }
    const owner = registry.get(ownerProcessId);
    if (!owner || owner.kind !== 'tim') {
      return { ok: false, reason: 'owner_not_registered' };
    }
    if (isTerminalState(owner.state)) {
      return { ok: false, reason: 'stale_executor' };
    }

    const clientId = registry.getExecutorOwnerChannel(executorId);
    if (!clientId) {
      return { ok: false, reason: 'owner_not_connected' };
    }
    const client = this.channels.get(clientId);
    if (!client?.connected) {
      return { ok: false, reason: 'owner_not_connected' };
    }

    const sent = client.send({
      type: 'terminate_executor',
      executorId,
      ...(requestId ? { requestId } : {}),
    });
    return sent ? { ok: true, clientId } : { ok: false, reason: 'send_failed' };
  }

  sendExecutorControl(executorId: ProcessId, requestId?: string): TunnelControlResult {
    return this.sendExecutorTermination(executorId, requestId);
  }

  private registerProcess(
    message: Extract<TunnelProcessMessage, { type: 'process_register' }>,
    client: TunnelProcessChannel
  ): boolean {
    const registry = this.registry;
    if (!registry) {
      return true;
    }

    const ownerProcessId = message.ownerProcessId ?? message.parentProcessId;
    const existing = registry.get(message.processId);
    if (existing) {
      if (
        existing.kind !== message.kind ||
        existing.parentProcessId !== message.parentProcessId ||
        existing.ownerProcessId !== ownerProcessId ||
        existing.label !== message.label
      ) {
        return false;
      }
      if (existing.kind === 'tim' && registry.getOwnerChannel(existing.processId) !== client.id) {
        return false;
      }
    }

    if (message.kind === 'executor' && !this.isOwnerChannel(ownerProcessId, client.id)) {
      return false;
    }

    const node = registry.register(
      {
        processId: message.processId,
        parentProcessId: message.parentProcessId,
        kind: message.kind,
        label: message.label,
        ownerProcessId,
        pid: message.pid,
        command: message.command,
        startIdentity: message.startIdentity,
        startedAt: message.startedAt,
        state: message.state,
      },
      message.kind === 'tim' ? { ownerChannelId: client.id } : {}
    );
    return node !== undefined;
  }

  private updateProcess(
    processId: ProcessId,
    message: Extract<TunnelProcessMessage, { type: 'process_update' }>,
    client: TunnelProcessChannel
  ): boolean {
    const registry = this.registry;
    if (!registry || !this.isProcessOwnedByClient(processId, client.id)) {
      return !registry;
    }
    if (!registry.has(processId)) {
      return true;
    }

    return (
      registry.update(processId, {
        parentProcessId: message.parentProcessId,
        ownerProcessId: message.ownerProcessId,
        label: message.label,
        pid: message.pid,
        command: message.command,
        startIdentity: message.startIdentity,
        state: message.state,
      }) !== undefined
    );
  }

  private exitProcess(
    processId: ProcessId,
    message: Extract<TunnelProcessMessage, { type: 'process_exit' }>,
    client: TunnelProcessChannel
  ): boolean {
    const registry = this.registry;
    if (!registry || !this.isProcessOwnedByClient(processId, client.id)) {
      return !registry;
    }
    if (!registry.has(processId)) {
      return true;
    }

    return (
      registry.exit(processId, {
        endedAt: message.endedAt,
        exitCode: message.exitCode,
        signal: message.signal,
      }) !== undefined
    );
  }

  private removeProcess(
    processId: ProcessId,
    subtree: boolean,
    client: TunnelProcessChannel
  ): boolean {
    const registry = this.registry;
    if (!registry || !this.isProcessOwnedByClient(processId, client.id)) {
      return !registry;
    }
    const node = registry.get(processId);
    if (!node) {
      return true;
    }
    if (isTerminalState(node.state) && !this.getProcessChannel(node.processId)) {
      return true;
    }

    registry.remove(processId, subtree);
    return true;
  }

  private receiveTerminationResult(
    executorId: ProcessId,
    message: Extract<TunnelProcessMessage, { type: 'terminate_executor_result' }>,
    client: TunnelProcessChannel
  ): boolean {
    const registry = this.registry;
    if (!registry || registry.getExecutorOwnerChannel(executorId) !== client.id) {
      return false;
    }

    registry.emitTerminationResult({
      executorId,
      requestId: message.requestId,
      result: message.result,
      error: message.error,
    });
    return true;
  }

  private isOwnerChannel(ownerProcessId: ProcessId | undefined, clientId: string): boolean {
    const registry = this.registry;
    if (!registry || !ownerProcessId) {
      return false;
    }
    const owner = registry.get(ownerProcessId);
    return Boolean(
      owner && owner.kind === 'tim' && registry.getOwnerChannel(ownerProcessId) === clientId
    );
  }

  private isProcessOwnedByClient(processId: ProcessId, clientId: string): boolean {
    const registry = this.registry;
    const node = registry?.get(processId);
    if (!registry || !node) {
      return true;
    }
    if (isTerminalState(node.state)) {
      // Terminal lifecycle messages are harmless no-ops. There is no live
      // capability left to authorize, and rejecting them would make exit
      // races observable to otherwise valid clients.
      return true;
    }

    const channelId = this.getProcessChannel(node.processId);
    return channelId === clientId;
  }

  private getProcessChannel(processId: ProcessId): string | undefined {
    const registry = this.registry;
    const node = registry?.get(processId);
    if (!registry || !node) {
      return undefined;
    }
    return node.kind === 'tim'
      ? registry.getOwnerChannel(node.processId)
      : node.ownerProcessId
        ? registry.getOwnerChannel(node.ownerProcessId)
        : undefined;
  }
}
