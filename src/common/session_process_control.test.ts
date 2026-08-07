import { describe, expect, it, vi } from 'vitest';
import {
  createNestedTimProcessRuntime,
  SessionProcessOwner,
  type SessionProcessTransport,
} from './session_process_control.js';
import {
  SessionProcessRegistry,
  TIM_OWNER_PROCESS_ID,
  TIM_PARENT_PROCESS_ID,
  TIM_PROCESS_ID,
  TIM_SESSION_ID,
  toProcessId,
  type ProcessId,
} from './session_process.js';
import type { ProcessInfo } from './process_listing.js';

function processId(value: string): ProcessId {
  const result = toProcessId(value);
  if (!result) {
    throw new Error(`Invalid test process ID: ${value}`);
  }
  return result;
}

function createTransport(): SessionProcessTransport & {
  registrations: Array<Record<string, unknown>>;
  updates: Array<{ processId: ProcessId; update: Record<string, unknown> }>;
  exits: Array<{ processId: ProcessId; details: Record<string, unknown> | undefined }>;
} {
  const registrations: Array<Record<string, unknown>> = [];
  const updates: Array<{ processId: ProcessId; update: Record<string, unknown> }> = [];
  const exits: Array<{ processId: ProcessId; details: Record<string, unknown> | undefined }> = [];
  return {
    registrations,
    updates,
    exits,
    registerProcess: (registration) => {
      registrations.push(registration);
      return true;
    },
    updateProcess: (processId, update) => {
      updates.push({ processId, update });
      return true;
    },
    exitProcess: (processId, details) => {
      exits.push({ processId, details });
      return true;
    },
    removeProcess: () => true,
  };
}

function createRegistry(): SessionProcessRegistry {
  const registry = new SessionProcessRegistry({ sessionId: 'session-1' });
  registry.register({ processId: processId('owner'), kind: 'tim', label: 'owner' });
  return registry;
}

function createOwner(
  processLister: () => ProcessInfo[],
  transport: SessionProcessTransport = createTransport()
): SessionProcessOwner {
  return new SessionProcessOwner({
    sessionId: 'session-1',
    ownerProcessId: processId('owner'),
    transport,
    processLister,
  });
}

function createProcessInfo(pid: number, command: string, startTime = 'start-1'): ProcessInfo {
  return { pid, ppid: process.pid, command, startTime };
}

describe('SessionProcessOwner', () => {
  it('registers before spawn, propagates identity, and removes the direct-child handle on exit', () => {
    const transport = createTransport();
    const processInfo = createProcessInfo(1234, 'claude --stream-json');
    const owner = createOwner(() => [processInfo], transport);
    const lifecycle = owner.prepareExecutor({
      label: 'Claude execution',
      command: 'claude --stream-json',
    });

    expect(lifecycle).toBeDefined();
    expect(transport.registrations).toMatchObject([
      {
        processId: lifecycle?.processId,
        parentProcessId: 'owner',
        ownerProcessId: 'owner',
        kind: 'executor',
        state: 'starting',
      },
    ]);
    expect(lifecycle?.environment).toEqual({
      TIM_SESSION_ID: 'session-1',
      TIM_PROCESS_ID: lifecycle?.processId,
      TIM_PARENT_PROCESS_ID: 'owner',
      TIM_OWNER_PROCESS_ID: 'owner',
    });

    const kill = vi.fn();
    lifecycle?.markSpawned({ pid: processInfo.pid, kill });
    expect(transport.updates).toContainEqual({
      processId: lifecycle?.processId,
      update: {
        pid: processInfo.pid,
        command: processInfo.command,
        startIdentity: processInfo.startTime,
        state: 'running',
      },
    });

    lifecycle?.markExited({ exitCode: 0 });
    expect(owner.childCount).toBe(0);
    expect(transport.exits).toContainEqual({
      processId: lifecycle?.processId,
      details: { exitCode: 0 },
    });
    expect(owner.terminateExecutor(lifecycle!.processId)).toBe('not_owned');
  });

  it('never signals when process inspection fails or the identity is stale', () => {
    const transport = createTransport();
    const processInfo = createProcessInfo(1234, 'codex exec');
    const processLister = vi.fn<() => ProcessInfo[]>(() => [processInfo]);
    const owner = createOwner(processLister, transport);
    const lifecycle = owner.prepareExecutor({ label: 'Codex', command: processInfo.command });
    const kill = vi.fn();
    lifecycle?.markSpawned({ pid: processInfo.pid, kill });

    processLister.mockImplementationOnce(() => {
      throw new Error('ps unavailable');
    });
    expect(owner.terminateExecutor(lifecycle!.processId)).toBe('unknown_process_state');
    expect(kill).not.toHaveBeenCalled();

    processLister.mockReturnValueOnce([createProcessInfo(processInfo.pid, 'unrelated')]);
    expect(owner.terminateExecutor(lifecycle!.processId)).toBe('stale_target');
    expect(kill).not.toHaveBeenCalled();
    expect(owner.childCount).toBe(0);
  });

  it('treats ESRCH as an already-completed stop and retries other signal errors', () => {
    const transport = createTransport();
    const processInfo = createProcessInfo(1234, 'claude');
    const processLister = vi.fn<() => ProcessInfo[]>(() => [processInfo]);
    const owner = createOwner(processLister, transport);
    const lifecycle = owner.prepareExecutor({ label: 'Claude', command: processInfo.command });
    const kill = vi.fn().mockImplementationOnce(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    lifecycle?.markSpawned({ pid: processInfo.pid, kill });

    expect(owner.terminateExecutor(lifecycle!.processId)).toBe('already_exited');
    expect(owner.childCount).toBe(0);

    const retryLifecycle = owner.prepareExecutor({ label: 'Claude retry', command: 'claude' });
    const retryKill = vi.fn().mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    lifecycle?.markExited();
    retryLifecycle?.markSpawned({ pid: processInfo.pid, kill: retryKill });

    expect(owner.terminateExecutor(retryLifecycle!.processId)).toBe('signal_failed');
    expect(owner.childCount).toBe(1);
    expect(owner.terminateExecutor(retryLifecycle.processId)).toBe('terminated');
    expect(retryKill).toHaveBeenCalledTimes(2);
  });

  it('uses the local registry for root-owned executors', () => {
    const registry = createRegistry();
    const processInfo = createProcessInfo(1234, 'codex app-server');
    const owner = new SessionProcessOwner({
      sessionId: 'session-1',
      ownerProcessId: processId('owner'),
      registry,
      processLister: () => [processInfo],
    });
    const lifecycle = owner.prepareExecutor({
      label: 'Codex app-server',
      command: processInfo.command,
    });
    expect(registry.get(lifecycle!.processId)?.state).toBe('starting');

    lifecycle?.markSpawned({ pid: processInfo.pid, kill: vi.fn() });
    expect(registry.get(lifecycle!.processId)).toMatchObject({
      state: 'running',
      pid: processInfo.pid,
      command: processInfo.command,
      startIdentity: processInfo.startTime,
    });
    lifecycle?.markExited({ signal: 'SIGTERM' });
    expect(registry.get(lifecycle!.processId)).toMatchObject({
      state: 'exited',
      signal: 'SIGTERM',
    });
  });

  it('safely handles a child that finishes spawning during owner disposal', () => {
    const transport = createTransport();
    const processInfo = createProcessInfo(1234, 'claude');
    const owner = createOwner(() => [processInfo], transport);
    const lifecycle = owner.prepareExecutor({ label: 'Claude', command: 'claude' });

    owner.dispose();

    const kill = vi.fn();
    lifecycle?.markSpawned({ pid: processInfo.pid, kill });
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(owner.terminateExecutor(lifecycle!.processId)).toBe('not_owned');
  });

  it('registers a nested tim below the inherited executor and restores its environment', () => {
    const previous = {
      [TIM_SESSION_ID]: process.env[TIM_SESSION_ID],
      [TIM_PROCESS_ID]: process.env[TIM_PROCESS_ID],
      [TIM_PARENT_PROCESS_ID]: process.env[TIM_PARENT_PROCESS_ID],
      [TIM_OWNER_PROCESS_ID]: process.env[TIM_OWNER_PROCESS_ID],
    };
    process.env[TIM_SESSION_ID] = 'session-1';
    process.env[TIM_PROCESS_ID] = 'executor-1';
    process.env[TIM_PARENT_PROCESS_ID] = 'owner';
    process.env[TIM_OWNER_PROCESS_ID] = 'owner';

    const transport = createTransport();
    const runtime = createNestedTimProcessRuntime(transport, 'tim subagent');
    expect(runtime).toBeDefined();
    expect(transport.registrations).toMatchObject([
      {
        processId: runtime?.processId,
        parentProcessId: 'executor-1',
        ownerProcessId: 'executor-1',
        kind: 'tim',
        label: 'tim subagent',
      },
    ]);
    expect(process.env[TIM_PROCESS_ID]).toBe(runtime?.processId);
    expect(process.env[TIM_PARENT_PROCESS_ID]).toBe('executor-1');
    expect(process.env[TIM_OWNER_PROCESS_ID]).toBe('executor-1');

    runtime?.dispose();
    expect(process.env[TIM_PROCESS_ID]).toBe('executor-1');
    expect(process.env[TIM_PARENT_PROCESS_ID]).toBe('owner');
    expect(process.env[TIM_OWNER_PROCESS_ID]).toBe('owner');
    expect(transport.exits).toContainEqual({
      processId: runtime?.processId,
      details: undefined,
    });

    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
});
