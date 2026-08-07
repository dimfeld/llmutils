import { describe, expect, it } from 'vitest';
import {
  createChildSessionProcessEnvironment,
  createSessionProcessRegistryFromEnvironment,
  isSessionProcessTrackingEnabled,
  readSessionProcessEnvironment,
  SessionProcessRegistry,
  TIM_PARENT_PROCESS_ID,
  TIM_PROCESS_ID,
  TIM_SESSION_ID,
  toProcessId,
  type ProcessId,
} from './session_process.ts';

function processId(value: string): ProcessId {
  const result = toProcessId(value);
  if (!result) {
    throw new Error(`Invalid test process ID: ${value}`);
  }
  return result;
}

function createRegistry(): SessionProcessRegistry {
  return new SessionProcessRegistry({
    sessionId: 'session-1',
    now: () => new Date('2026-08-07T12:00:00.000Z'),
  });
}

describe('SessionProcessRegistry', () => {
  it('stays inactive without a live session transport', () => {
    const registry = createSessionProcessRegistryFromEnvironment({});

    expect(registry.isActive).toBe(false);
    expect(registry.register({ kind: 'tim', label: 'root' })).toBeUndefined();
    expect(registry.getSnapshot()).toEqual([]);
    expect(isSessionProcessTrackingEnabled({})).toBe(false);
  });

  it('propagates opaque process relationships through explicit environment values', () => {
    const inherited = {
      [TIM_SESSION_ID]: 'old-session',
      [TIM_PROCESS_ID]: 'old-process',
      [TIM_PARENT_PROCESS_ID]: 'old-parent',
      KEEP_ME: 'yes',
    };
    const child = createChildSessionProcessEnvironment(inherited, {
      sessionId: 'session-1',
      parentProcessId: processId('executor-1'),
      ownerProcessId: processId('executor-1'),
      processId: processId('tim-1'),
    });

    expect(child.processId).toBe(processId('tim-1'));
    expect(child.env).toMatchObject({
      KEEP_ME: 'yes',
      [TIM_SESSION_ID]: 'session-1',
      [TIM_PROCESS_ID]: 'tim-1',
      [TIM_PARENT_PROCESS_ID]: 'executor-1',
    });
    expect(readSessionProcessEnvironment(child.env)).toEqual({
      sessionId: 'session-1',
      processId: processId('tim-1'),
      parentProcessId: processId('executor-1'),
      ownerProcessId: processId('executor-1'),
    });
  });

  it('requires a session plus either headless or tunnel transport', () => {
    expect(
      isSessionProcessTrackingEnabled({ [TIM_SESSION_ID]: 'session-1' }, { headlessSession: true })
    ).toBe(true);
    expect(
      isSessionProcessTrackingEnabled(
        { [TIM_SESSION_ID]: 'session-1', TIM_OUTPUT_SOCKET: '/tmp/t.sock' },
        { parentTunnelActive: true }
      )
    ).toBe(true);
    expect(
      isSessionProcessTrackingEnabled(
        { [TIM_SESSION_ID]: 'session-1' },
        { parentTunnelActive: false }
      )
    ).toBe(false);
  });

  it('keeps nested and parallel branches in parent-before-child order', () => {
    const registry = createRegistry();
    const root = processId('root');
    const executorA = processId('executor-a');
    const timA = processId('tim-a');
    const executorAChild = processId('executor-a-child');
    const executorB = processId('executor-b');

    expect(registry.register({ processId: root, kind: 'tim', label: 'root tim' })).toBeDefined();
    expect(
      registry.register({
        processId: executorA,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'orchestrator A',
      })
    ).toBeDefined();
    expect(
      registry.register({
        processId: timA,
        parentProcessId: executorA,
        ownerProcessId: executorA,
        kind: 'tim',
        label: 'subagent A',
      })
    ).toBeDefined();
    expect(
      registry.register({
        processId: executorAChild,
        parentProcessId: timA,
        ownerProcessId: timA,
        kind: 'executor',
        label: 'subagent executor A',
      })
    ).toBeDefined();
    expect(
      registry.register({
        processId: executorB,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'orchestrator B',
      })
    ).toBeDefined();

    expect(registry.getSnapshot().map((node) => node.processId)).toEqual([
      root,
      executorA,
      timA,
      executorAChild,
      executorB,
    ]);
  });

  it('makes duplicate registration and late lifecycle events harmless', () => {
    const registry = createRegistry();
    const root = processId('root');
    const executor = processId('executor');
    const changes: string[] = [];
    registry.subscribe((change) => changes.push(change.type));

    registry.register({ processId: root, kind: 'tim', label: 'root' });
    registry.register({
      processId: executor,
      parentProcessId: root,
      ownerProcessId: root,
      kind: 'executor',
      label: 'executor',
    });
    const duplicate = registry.register({
      processId: executor,
      parentProcessId: root,
      ownerProcessId: root,
      kind: 'executor',
      label: 'executor',
    });
    expect(duplicate?.processId).toBe(executor);
    expect(registry.size).toBe(2);

    registry.exit(executor, { exitCode: 0 });
    registry.exit(executor, { exitCode: 1 });
    registry.update(executor, { state: 'running', label: 'late update' });
    registry.register({
      processId: executor,
      parentProcessId: root,
      ownerProcessId: root,
      kind: 'executor',
      label: 'executor',
      state: 'running',
    });

    expect(registry.get(executor)).toMatchObject({
      state: 'exited',
      exitCode: 0,
      label: 'executor',
    });
    expect(changes).toEqual(['registered', 'registered', 'exited']);
  });

  it('removes a disconnected owner subtree and routes owner channels by node identity', () => {
    const registry = createRegistry();
    const root = processId('root');
    const rootExecutor = processId('root-executor');
    const timA = processId('tim-a');
    const executorA = processId('executor-a');
    const timB = processId('tim-b');

    registry.register({ processId: root, kind: 'tim', label: 'root' });
    registry.register({
      processId: rootExecutor,
      parentProcessId: root,
      ownerProcessId: root,
      kind: 'executor',
      label: 'root executor',
    });
    registry.register(
      {
        processId: timA,
        parentProcessId: rootExecutor,
        ownerProcessId: rootExecutor,
        kind: 'tim',
        label: 'tim A',
      },
      { ownerChannelId: 'client-a' }
    );
    expect(
      registry.register(
        {
          processId: timA,
          parentProcessId: rootExecutor,
          ownerProcessId: rootExecutor,
          kind: 'tim',
          label: 'tim A',
        },
        { ownerChannelId: 'client-b' }
      )
    ).toBeUndefined();
    registry.register({
      processId: executorA,
      parentProcessId: timA,
      ownerProcessId: timA,
      kind: 'executor',
      label: 'executor A',
    });
    registry.register(
      {
        processId: timB,
        parentProcessId: rootExecutor,
        ownerProcessId: rootExecutor,
        kind: 'tim',
        label: 'tim B',
      },
      { ownerChannelId: 'client-b' }
    );

    expect(registry.getExecutorOwnerChannel(executorA)).toBe('client-a');
    expect(registry.releaseChannel('client-a')).toEqual([executorA, timA]);
    expect(registry.get(executorA)).toBeUndefined();
    expect(registry.get(timA)).toBeUndefined();
    expect(registry.get(timB)).toBeDefined();
    expect(registry.getExecutorOwnerChannel(executorA)).toBeUndefined();
  });

  it('can mark an owner subtree orphaned without deleting its history', () => {
    const registry = createRegistry();
    const root = processId('root');
    const executor = processId('executor');
    const tim = processId('tim');
    registry.register({ processId: root, kind: 'tim', label: 'root' });
    registry.register({
      processId: executor,
      parentProcessId: root,
      ownerProcessId: root,
      kind: 'executor',
      label: 'executor',
    });
    registry.register(
      {
        processId: tim,
        parentProcessId: executor,
        ownerProcessId: executor,
        kind: 'tim',
        label: 'nested tim',
      },
      { ownerChannelId: 'client-a' }
    );

    expect(registry.releaseChannel('client-a', 'orphan')).toEqual([tim]);
    expect(registry.get(tim)).toMatchObject({ state: 'orphaned' });
  });

  it('does not regress a running node to starting on a late update', () => {
    const registry = createRegistry();
    const root = processId('root');
    const executor = processId('executor');
    registry.register({ processId: root, kind: 'tim', label: 'root' });
    registry.register({
      processId: executor,
      parentProcessId: root,
      ownerProcessId: root,
      kind: 'executor',
      label: 'executor',
      state: 'starting',
    });

    expect(registry.update(executor, { state: 'running' })?.state).toBe('running');
    expect(registry.update(executor, { state: 'starting', command: 'agent' })).toMatchObject({
      state: 'running',
      command: 'agent',
    });
  });
});
