import { describe, expect, it } from 'vitest';
import {
  createChildSessionProcessEnvironment,
  createProcessId,
  createSessionProcessRegistryFromEnvironment,
  isSessionProcessTrackingEnabled,
  isValidSessionProcessExit,
  isValidSessionProcessNode,
  isValidSessionProcessRegistration,
  isValidSessionProcessTerminationResultEvent,
  isValidSessionProcessUpdate,
  SessionProcessRegistryLifecycleSink,
  readSessionProcessEnvironment,
  SessionProcessRegistry,
  TIM_OWNER_PROCESS_ID,
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

const MAX_PROCESS_COMMAND_LENGTH = 64 * 1024;

function processCommand(length: number): string {
  return `codex ${'prompt-token '.repeat(Math.ceil((length - 6) / 13))}`.slice(0, length);
}

describe('session process payload validators', () => {
  const root = processId('root');
  const executor = processId('executor');

  it('accepts valid domain payloads and rejects unsafe metadata', () => {
    expect(
      isValidSessionProcessRegistration({
        processId: executor,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'executor',
        command: 'tim agent',
        startIdentity: 'Fri Aug  7 12:00:00 2026',
        startedAt: '2026-08-07T12:00:00.000Z',
        state: 'starting',
      })
    ).toBe(true);
    expect(isValidSessionProcessRegistration({ kind: 'executor', label: 'executor' })).toBe(true);
    expect(
      isValidSessionProcessRegistration({
        kind: 'executor',
        label: 'executor',
        command: 'x'.repeat(2049),
      })
    ).toBe(true);
    expect(isValidSessionProcessUpdate({ pid: null, command: null, state: 'running' })).toBe(true);
    expect(isValidSessionProcessUpdate({ label: '   ' })).toBe(false);
    expect(isValidSessionProcessExit({ exitCode: null, signal: 'SIGTERM' })).toBe(true);
    expect(isValidSessionProcessExit({ endedAt: '' })).toBe(false);
    expect(
      isValidSessionProcessNode({
        processId: executor,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'executor',
        startedAt: '2026-08-07T12:00:00.000Z',
        state: 'running',
      })
    ).toBe(true);
    expect(
      isValidSessionProcessTerminationResultEvent({
        executorId: executor,
        requestId: 'request-1',
        result: 'terminated',
      })
    ).toBe(true);
    expect(
      isValidSessionProcessTerminationResultEvent({
        executorId: executor,
        requestId: 'request-1',
        result: 'terminated',
        error: 'x'.repeat(4097),
      })
    ).toBe(false);
  });

  it('accepts diagnostic commands through 64 KiB while keeping identity fields strict', () => {
    const commandAtLimit = processCommand(MAX_PROCESS_COMMAND_LENGTH);
    const commandOverLimit = processCommand(MAX_PROCESS_COMMAND_LENGTH + 1);

    expect(commandAtLimit).toHaveLength(MAX_PROCESS_COMMAND_LENGTH);
    expect(commandOverLimit).toHaveLength(MAX_PROCESS_COMMAND_LENGTH + 1);
    expect(
      isValidSessionProcessRegistration({
        processId: executor,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'long executor',
        command: commandAtLimit,
      })
    ).toBe(true);
    expect(isValidSessionProcessUpdate({ command: commandAtLimit, state: 'running' })).toBe(true);
    expect(
      isValidSessionProcessNode({
        processId: executor,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'long executor',
        command: commandAtLimit,
        startedAt: '2026-08-07T12:00:00.000Z',
        state: 'running',
      })
    ).toBe(true);
    expect(
      isValidSessionProcessRegistration({
        processId: executor,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'long executor',
        command: commandOverLimit,
      })
    ).toBe(false);
    expect(isValidSessionProcessUpdate({ command: commandOverLimit })).toBe(false);
    expect(
      isValidSessionProcessRegistration({
        processId: 'not an opaque process id' as ProcessId,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'long executor',
        command: commandAtLimit,
      })
    ).toBe(false);
    expect(
      isValidSessionProcessRegistration({
        processId: executor,
        parentProcessId: 'not an opaque parent id' as ProcessId,
        ownerProcessId: root,
        kind: 'executor',
        label: 'long executor',
        command: commandAtLimit,
      })
    ).toBe(false);
    expect(
      isValidSessionProcessRegistration({
        processId: executor,
        parentProcessId: root,
        ownerProcessId: 'not an opaque owner id' as ProcessId,
        kind: 'executor',
        label: 'long executor',
        command: commandAtLimit,
      })
    ).toBe(false);
  });
});

describe('SessionProcessRegistryLifecycleSink', () => {
  it('degrades to safe no-ops when its registry is inactive', () => {
    const registry = createSessionProcessRegistryFromEnvironment({});
    const sink = new SessionProcessRegistryLifecycleSink(registry);
    const process = processId('inactive-process');

    expect(
      sink.registerProcess({ processId: process, kind: 'tim', label: 'inactive process' })
    ).toBe(true);
    expect(sink.updateProcess(process, { state: 'running' })).toBe(true);
    expect(sink.exitProcess(process)).toBe(true);
    expect(sink.removeProcess(process)).toBe(true);
    expect(registry.getSnapshot()).toEqual([]);
  });
});

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

  it('rejects invalid inherited relationships and clears stale child relationships', () => {
    expect(
      readSessionProcessEnvironment({
        [TIM_SESSION_ID]: 'session-1',
        [TIM_PROCESS_ID]: 'not valid',
      })
    ).toBeUndefined();
    expect(
      readSessionProcessEnvironment({
        [TIM_SESSION_ID]: 'session-1',
        [TIM_PROCESS_ID]: 'tim-1',
        [TIM_PARENT_PROCESS_ID]: 'not valid',
      })
    ).toBeUndefined();
    expect(
      readSessionProcessEnvironment({
        [TIM_SESSION_ID]: 'session-1',
        [TIM_PROCESS_ID]: 'tim-1',
        [TIM_OWNER_PROCESS_ID]: 'not valid',
      })
    ).toBeUndefined();

    const child = createChildSessionProcessEnvironment(
      {
        [TIM_SESSION_ID]: 'old-session',
        [TIM_PROCESS_ID]: 'old-process',
        [TIM_PARENT_PROCESS_ID]: 'old-parent',
        [TIM_OWNER_PROCESS_ID]: 'old-owner',
      },
      { sessionId: 'session-1', processId: processId('root-child') }
    );

    expect(child.env[TIM_PARENT_PROCESS_ID]).toBeUndefined();
    expect(child.env[TIM_OWNER_PROCESS_ID]).toBeUndefined();
    expect(readSessionProcessEnvironment(child.env)).toEqual({
      sessionId: 'session-1',
      processId: processId('root-child'),
    });
  });

  it('validates generated and parsed opaque process IDs', () => {
    expect(toProcessId('valid-id')).toBe(processId('valid-id'));
    expect(toProcessId('')).toBeUndefined();
    expect(toProcessId('has whitespace')).toBeUndefined();
    expect(toProcessId('x'.repeat(257))).toBeUndefined();
    expect(() => createProcessId(() => 'bad id')).toThrow(/invalid opaque ID/i);
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

  it('rejects invalid node kinds, relationships, and metadata without changing the tree', () => {
    const registry = createRegistry();
    const root = processId('root');
    const executor = processId('executor');
    const nestedTim = processId('nested-tim');

    expect(registry.register({ processId: root, kind: 'tim', label: 'root' })).toBeDefined();
    expect(
      registry.register({ processId: executor, kind: 'executor', label: 'root executor' })
    ).toBeUndefined();
    expect(
      registry.register({
        processId: nestedTim,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'tim',
        label: 'invalid parent kind',
      })
    ).toBeUndefined();
    expect(
      registry.register({
        processId: executor,
        parentProcessId: root,
        ownerProcessId: processId('unknown-owner'),
        kind: 'executor',
        label: 'invalid owner kind',
      })
    ).toBeUndefined();
    expect(
      registry.register({
        processId: executor,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'valid default relationship',
      })
    ).toBeDefined();
    expect(registry.get(executor)?.ownerProcessId).toBe(root);
    expect(registry.remove(executor)).toEqual([executor]);
    expect(
      registry.register({
        processId: executor,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: '   ',
      })
    ).toBeUndefined();
    expect(
      registry.register({
        processId: executor,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'invalid pid',
        pid: 0,
      })
    ).toBeUndefined();
    expect(registry.size).toBe(1);
    expect(registry.getSnapshot().map((node) => node.processId)).toEqual([root]);
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

  it('merges duplicate registration metadata but rejects identity changes', () => {
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
      state: 'starting',
    });

    expect(
      registry.register({
        processId: executor,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'executor',
        pid: 42,
        command: 'agent --run',
        state: 'running',
      })
    ).toMatchObject({
      processId: executor,
      pid: 42,
      command: 'agent --run',
      state: 'running',
    });
    expect(
      registry.register({
        processId: executor,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'renamed executor',
      })
    ).toBeUndefined();
    expect(
      registry.register({
        processId: executor,
        parentProcessId: processId('other-parent'),
        ownerProcessId: root,
        kind: 'executor',
        label: 'executor',
      })
    ).toBeUndefined();

    expect(registry.get(executor)).toMatchObject({
      label: 'executor',
      pid: 42,
      command: 'agent --run',
      state: 'running',
    });
    expect(changes).toEqual(['registered', 'registered', 'updated']);
  });

  it('retains command metadata through the 64 KiB registration and update boundary', () => {
    const registry = createRegistry();
    const root = processId('root');
    const executor = processId('long-command-executor');
    const maxExecutor = processId('max-command-executor');
    const overLimitExecutor = processId('over-limit-executor');
    const commandOver2048 = processCommand(2049);
    const commandAtLimit = processCommand(MAX_PROCESS_COMMAND_LENGTH);
    const commandOverLimit = processCommand(MAX_PROCESS_COMMAND_LENGTH + 1);

    expect(commandOver2048).toHaveLength(2049);
    expect(commandAtLimit).toHaveLength(MAX_PROCESS_COMMAND_LENGTH);
    registry.register({ processId: root, kind: 'tim', label: 'root' });

    expect(
      registry.register({
        processId: executor,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'long Codex executor',
        command: commandOver2048,
        state: 'starting',
      })
    ).toMatchObject({ command: commandOver2048, state: 'starting' });

    expect(registry.update(executor, { command: commandAtLimit, state: 'running' })).toMatchObject({
      command: commandAtLimit,
      state: 'running',
    });
    expect(registry.update(executor, { command: commandOverLimit })).toBeUndefined();
    expect(registry.get(executor)?.command).toBe(commandAtLimit);

    expect(
      registry.register({
        processId: maxExecutor,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'maximum command executor',
        command: commandAtLimit,
      })
    ).toMatchObject({ command: commandAtLimit });
    expect(
      registry.register({
        processId: overLimitExecutor,
        parentProcessId: root,
        ownerProcessId: root,
        kind: 'executor',
        label: 'over-limit executor',
        command: commandOverLimit,
      })
    ).toBeUndefined();
    expect(registry.has(overLimitExecutor)).toBe(false);
    expect(isValidSessionProcessNode(registry.get(executor))).toBe(true);
    expect(
      isValidSessionProcessRegistration({
        kind: 'executor',
        label: 'executor',
        command: commandAtLimit,
        startIdentity: 'x'.repeat(2049),
      })
    ).toBe(false);
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

  it('marks every descendant of a lost owner and leaves sibling branches live', () => {
    const registry = createRegistry();
    const root = processId('root');
    const rootExecutor = processId('root-executor');
    const timA = processId('tim-a');
    const executorA = processId('executor-a');
    const nestedTimA = processId('nested-tim-a');
    const timB = processId('tim-b');
    const executorB = processId('executor-b');
    const changes: string[] = [];
    registry.subscribe((change) => changes.push(change.type));

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
    registry.register({
      processId: executorA,
      parentProcessId: timA,
      ownerProcessId: timA,
      kind: 'executor',
      label: 'executor A',
    });
    registry.register(
      {
        processId: nestedTimA,
        parentProcessId: executorA,
        ownerProcessId: executorA,
        kind: 'tim',
        label: 'nested tim A',
      },
      { ownerChannelId: 'client-a' }
    );
    registry.register({
      processId: timB,
      parentProcessId: rootExecutor,
      ownerProcessId: rootExecutor,
      kind: 'tim',
      label: 'tim B',
    });
    registry.register({
      processId: executorB,
      parentProcessId: timB,
      ownerProcessId: timB,
      kind: 'executor',
      label: 'executor B',
    });

    expect(registry.releaseChannel('client-a', 'orphan')).toEqual([timA, executorA, nestedTimA]);
    expect(registry.get(timA)).toMatchObject({ state: 'orphaned' });
    expect(registry.get(executorA)).toMatchObject({ state: 'orphaned' });
    expect(registry.get(nestedTimA)).toMatchObject({ state: 'orphaned' });
    expect(registry.get(executorB)).toMatchObject({ state: 'running' });
    expect(registry.getExecutorOwnerChannel(executorA)).toBeUndefined();
    expect(changes.at(-1)).toBe('owner_lost');
    expect(registry.releaseChannel('client-a', 'orphan')).toEqual([]);
  });

  it('does not expose mutable internal nodes and isolates listener failures', () => {
    const registry = createRegistry();
    const root = processId('root');
    const listenerCalls: string[] = [];
    registry.subscribe(() => {
      throw new Error('listener failure');
    });
    registry.subscribe((change) => listenerCalls.push(change.type));

    const node = registry.register({ processId: root, kind: 'tim', label: 'root' });
    expect(node).toBeDefined();
    node!.label = 'mutated outside registry';
    const snapshot = registry.getSnapshot();
    snapshot[0]!.label = 'mutated snapshot';

    expect(registry.get(root)).toMatchObject({ label: 'root' });
    expect(listenerCalls).toEqual(['registered']);
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
