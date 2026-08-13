import { promises as fs } from 'node:fs';
import * as os from 'node:os';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  AGENT_MESSAGING_RUNTIME_PREFIX,
  MAX_AGENT_MESSAGE_BYTES,
  MAX_AGENT_NAME_LENGTH,
  MAX_PENDING_MESSAGES_PER_RECIPIENT,
  MAX_SUBAGENTS_PER_SESSION,
  ORCHESTRATOR_AGENT_NAME,
} from './contracts.js';
import { AgentManagerError, createAgentManager, createAgentPreparation } from './index.js';
import { FakeAgentInputAdapter, FakeAgentLauncher, FakeAgentPreparer } from './fake_provider.js';
import { formatAgentProcessLabel } from './agent_process_labels.js';
import { createAgentMessagingSessionRuntime } from './session_runtime.js';
import { getDefaultConfig } from '../configSchema.js';
import type {
  AgentLaunchRequest,
  AgentPreparationRequest,
  PreparedAgentExecution,
} from './agent_manager_types.js';
import type { PreparedSubagentExecution } from '../subagents/types.js';
import type { AgentManager } from './agent_manager.js';

const managers: AgentManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close().catch(() => undefined)));
});

function idGenerator(): () => string {
  let next = 1;
  return (): string => `agent-id-${next++}`;
}

function reservationRequest(
  name: string | undefined,
  type: 'implementer' | 'tester' | 'tdd-tests' | 'reviewer' = 'implementer'
): {
  name?: string;
  type: typeof type;
  executor: 'claude-code' | 'codex-cli';
  initialMessage: string;
} {
  return {
    ...(name === undefined ? {} : { name }),
    type,
    executor: 'codex-cli',
    initialMessage: `Initial message for ${name ?? type}`,
  };
}

function preparedExecutionFor(request: AgentPreparationRequest): PreparedAgentExecution {
  return {
    agentType: request.identity.type,
    executor: request.identity.executor,
    model: undefined,
    plan: {
      id: 1,
      title: 'Agent manager test plan',
      status: 'pending',
      tasks: [],
    },
    planId: 1,
    planPath: '/tmp/agent-manager-test-plan.md',
    gitRoot: '/tmp/agent-manager-test-repository',
    useJj: false,
    prompt: 'Prepared agent prompt.',
    config: getDefaultConfig(),
    timEnvironment: { context: {} },
  };
}

function createPreparer(): FakeAgentPreparer {
  return new FakeAgentPreparer(preparedExecutionFor);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Condition did not become true');
}

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

async function createManager(
  options: Parameters<typeof createAgentManager>[0] = {}
): Promise<AgentManager> {
  const manager = await createAgentManager({ agentIdGenerator: idGenerator(), ...options });
  managers.push(manager);
  return manager;
}

async function startFakeAgent(
  manager: AgentManager,
  launcher: FakeAgentLauncher,
  name: string,
  type: 'implementer' | 'tester' | 'tdd-tests' | 'reviewer' = 'tester'
): Promise<Awaited<ReturnType<FakeAgentLauncher['waitForNextLaunch']>>> {
  const launchPromise = launcher.waitForNextLaunch();
  const startPromise = manager.startAgent(manager.orchestratorIdentity, {
    name,
    type,
    executor: 'codex-cli',
    initialMessage: `Initial message for ${name}`,
  });
  const launch = await launchPromise;
  launch.handle.markReady();
  await startPromise;
  return launch;
}

describe('AgentManager root registration and snapshots', () => {
  test('registers one ready orchestrator mailbox and excludes it from capacity', async () => {
    const manager = await createManager({ orchestratorExecutor: 'codex-cli' });
    const listed = manager.listAgents();

    expect(listed.agents).toHaveLength(1);
    expect(listed.agents[0]).toMatchObject({
      name: ORCHESTRATOR_AGENT_NAME,
      role: 'orchestrator',
      executor: 'codex-cli',
      state: 'running-idle',
    });
    expect(listed.agents[0]?.id).toBe(manager.orchestratorIdentity.id);
    expect(manager.orchestratorIdentity.name).toBe(ORCHESTRATOR_AGENT_NAME);
    expect(manager.subagentCount).toBe(0);

    const registrations = await manager.sessionRuntime.runtime.listRegistrations();
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      id: manager.orchestratorIdentity.id,
      name: ORCHESTRATOR_AGENT_NAME,
      role: 'orchestrator',
      state: 'running-idle',
    });
    const socketPath = registrations[0]?.socketPath;
    expect(socketPath).toBeDefined();
    await expect(fs.stat(socketPath as string)).resolves.toBeTruthy();
  });

  test('uses immutable snapshots with the root first and stable creation ordering', async () => {
    const manager = await createManager();
    const first = manager.reserveSubagent(reservationRequest('zulu'));
    const second = manager.reserveSubagent(reservationRequest('alpha', 'tester'));

    const listed = manager.listAgents();
    expect(listed.agents.map((agent) => agent.name)).toEqual(['orchestrator', 'zulu', 'alpha']);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed.agents)).toBe(true);
    expect(Object.isFrozen(listed.agents[0])).toBe(true);
    expect(() => listed.agents.push(listed.agents[0] as never)).toThrow();

    const firstSnapshot = manager.getAgentSnapshot(first.id);
    expect(firstSnapshot).toMatchObject({
      identity: { id: first.id, name: 'zulu', type: 'implementer' },
      state: 'starting',
      inputActivity: 'not-ready',
    });
    expect(firstSnapshot?.identity).not.toBe(first.identity);
    expect(second.id).not.toBe(first.id);
    first.release();
    second.release();
  });

  test('does not close an existing session when duplicate manager initialization fails', async () => {
    const first = await createManager({ agentIdGenerator: () => 'root-id' });
    const session = first.sessionRuntime;

    await expect(
      createAgentManager({ sessionRuntime: session, agentIdGenerator: () => 'other-id' })
    ).rejects.toMatchObject({
      name: 'AgentManagerError',
      code: 'root_registration_failed',
    });
    expect(session.isClosed).toBe(false);
    expect(session.runtime.rootPath).toBeTruthy();
  });

  test('aborts a start paused in preparation when an injected runtime manager closes', async () => {
    const session = await createAgentMessagingSessionRuntime();
    const preparationStarted = deferred<void>();
    const preparation = deferred<PreparedAgentExecution>();
    let preparationRequest: AgentPreparationRequest | undefined;
    const preparer = {
      prepare: async (request: AgentPreparationRequest): Promise<PreparedAgentExecution> => {
        preparationRequest = request;
        preparationStarted.resolve(undefined);
        return preparation.promise;
      },
    };
    let manager: AgentManager | undefined;
    let foreign: Awaited<ReturnType<typeof session.register>> | undefined;
    try {
      manager = await createManager({
        sessionRuntime: session,
        agentPreparer: preparer,
        agentLauncher: new FakeAgentLauncher(),
      });
      const startPromise = manager
        .startAgent(manager.orchestratorIdentity, reservationRequest('close-during-preparation'))
        .then(
          (): undefined => undefined,
          (error: unknown): unknown => error
        );
      await preparationStarted.promise;

      await manager.close();
      expect(manager.listAgents().agents).toEqual([]);
      expect(manager.subagentCount).toBe(0);
      expect(await session.runtime.listRegistrations()).toEqual([]);
      expect(session.isClosed).toBe(false);

      await expect(startPromise).resolves.toMatchObject({ code: 'manager_closed' });
      preparation.resolve(preparedExecutionFor(preparationRequest as AgentPreparationRequest));
      expect(manager.listAgents().agents).toEqual([]);
      expect(await session.runtime.listRegistrations()).toEqual([]);

      foreign = await session.register({
        registration: {
          id: 'foreign-after-close',
          name: 'foreign-after-close',
          role: 'subagent',
          type: 'tester',
          executor: 'codex-cli',
          state: 'running-idle',
        },
        deliver: async (): Promise<'temporarily-unavailable'> => 'temporarily-unavailable',
      });
      expect(await session.runtime.listRegistrations()).toEqual([
        expect.objectContaining({ id: 'foreign-after-close', name: 'foreign-after-close' }),
      ]);
    } finally {
      await foreign?.deregister().catch(() => undefined);
      await manager?.close().catch(() => undefined);
      await session.close();
    }
  });

  test('cleans an in-flight mailbox and handle when an injected runtime manager closes', async () => {
    const session = await createAgentMessagingSessionRuntime();
    const launcher = new FakeAgentLauncher();
    let manager: AgentManager | undefined;
    let foreign: Awaited<ReturnType<typeof session.register>> | undefined;
    try {
      manager = await createManager({
        sessionRuntime: session,
        agentPreparer: createPreparer(),
        agentLauncher: launcher,
      });
      const launchPromise = launcher.waitForNextLaunch();
      const startPromise = manager
        .startAgent(manager.orchestratorIdentity, reservationRequest('close-during-readiness'))
        .then(
          (): undefined => undefined,
          (error: unknown): unknown => error
        );
      const launch = await launchPromise;
      await waitFor(
        () => manager?.getAgentSnapshot(launch.request.identity.id)?.processControlId !== undefined
      );

      await manager.close();
      expect(launch.handle.isReleased).toBe(true);
      expect(launch.handle.releaseCount).toBe(1);
      expect(manager.listAgents().agents).toEqual([]);
      expect(manager.subagentCount).toBe(0);
      expect(await session.runtime.listRegistrations()).toEqual([]);
      expect(session.isClosed).toBe(false);

      await expect(startPromise).resolves.toMatchObject({ code: 'manager_closed' });
      launch.handle.markReady();
      expect(manager.listAgents().agents).toEqual([]);
      expect(await session.runtime.listRegistrations()).toEqual([]);

      foreign = await session.register({
        registration: {
          id: 'foreign-after-readiness-close',
          name: 'foreign-after-readiness-close',
          role: 'subagent',
          type: 'tester',
          executor: 'codex-cli',
          state: 'running-idle',
        },
        deliver: async (): Promise<'temporarily-unavailable'> => 'temporarily-unavailable',
      });
      expect(await session.runtime.listRegistrations()).toEqual([
        expect.objectContaining({
          id: 'foreign-after-readiness-close',
          name: 'foreign-after-readiness-close',
        }),
      ]);
    } finally {
      await foreign?.deregister().catch(() => undefined);
      await manager?.close().catch(() => undefined);
      await session.close();
    }
  });

  test('releases an in-flight handle when an owned runtime manager closes', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager
      .startAgent(manager.orchestratorIdentity, reservationRequest('close-owned-runtime'))
      .then(
        (): undefined => undefined,
        (error: unknown): unknown => error
      );
    const launch = await launchPromise;

    await manager.close();
    expect(launch.handle.isReleased).toBe(true);
    expect(launch.handle.releaseCount).toBe(1);
    expect(manager.listAgents().agents).toEqual([]);
    expect(manager.subagentCount).toBe(0);
    expect(manager.sessionRuntime.isClosed).toBe(true);

    await expect(startPromise).resolves.toMatchObject({ code: 'manager_closed' });
    launch.handle.markReady();
    expect(manager.listAgents().agents).toEqual([]);
  });

  test('cleans up an owned runtime when root registration fails', async () => {
    const before = new Set(
      (await fs.readdir(os.tmpdir())).filter((entry) =>
        entry.startsWith(AGENT_MESSAGING_RUNTIME_PREFIX)
      )
    );

    await expect(
      createAgentManager({
        agentIdGenerator: () => 'r'.repeat(90),
        maxAgentIdGenerationAttempts: 1,
      })
    ).rejects.toMatchObject({
      name: 'AgentManagerError',
      code: 'root_registration_failed',
    });

    const after = new Set(
      (await fs.readdir(os.tmpdir())).filter((entry) =>
        entry.startsWith(AGENT_MESSAGING_RUNTIME_PREFIX)
      )
    );
    expect(after).toEqual(before);
  });

  test('keeps an injected runtime open when root registration fails', async () => {
    const session = await createAgentMessagingSessionRuntime();
    const rootPath = session.runtime.rootPath;

    await expect(
      createAgentManager({
        sessionRuntime: session,
        agentIdGenerator: () => 'r'.repeat(90),
        maxAgentIdGenerationAttempts: 1,
      })
    ).rejects.toMatchObject({
      name: 'AgentManagerError',
      code: 'root_registration_failed',
    });

    expect(session.isClosed).toBe(false);
    await expect(fs.stat(rootPath)).resolves.toBeTruthy();
    expect(await session.runtime.listRegistrations()).toEqual([]);
    await session.close();
  });

  test('closes only the manager-owned registrations when sharing a runtime', async () => {
    const session = await createAgentMessagingSessionRuntime();
    try {
      const launcher = new FakeAgentLauncher();
      const manager = await createManager({
        sessionRuntime: session,
        agentPreparer: createPreparer(),
        agentLauncher: launcher,
      });
      await startFakeAgent(manager, launcher, 'manager-agent');
      const peer = await session.register({
        registration: {
          id: 'shared-peer-id',
          name: 'shared-peer',
          role: 'subagent',
          type: 'tester',
          executor: 'codex-cli',
          state: 'running-idle',
        },
        deliver: async (): Promise<'temporarily-unavailable'> => 'temporarily-unavailable',
      });

      await manager.close();

      expect(manager.listAgents().agents).toEqual([]);
      expect(session.isClosed).toBe(false);
      expect(await session.runtime.listRegistrations()).toEqual([
        expect.objectContaining({ id: peer.registration.id, name: 'shared-peer' }),
      ]);

      await peer.deregister();
    } finally {
      await session.close();
    }
  });

  test('isolates identities, names, registrations, and cleanup across managers', async () => {
    const first = await createManager({
      agentIdGenerator: (() => {
        const ids = ['first-root', 'first-agent'];
        return (): string => ids.shift() ?? 'unused';
      })(),
    });
    const second = await createManager({
      agentIdGenerator: (() => {
        const ids = ['second-root', 'second-agent'];
        return (): string => ids.shift() ?? 'unused';
      })(),
    });

    const firstReservation = first.reserveSubagent(reservationRequest('shared-name'));
    const secondReservation = second.reserveSubagent(reservationRequest('shared-name'));

    expect(first.sessionRuntime.runtime.rootPath).not.toBe(second.sessionRuntime.runtime.rootPath);
    expect(firstReservation.id).not.toBe(secondReservation.id);
    expect(first.listAgents().agents.map((agent) => agent.name)).toEqual([
      ORCHESTRATOR_AGENT_NAME,
      'shared-name',
    ]);
    expect(second.listAgents().agents.map((agent) => agent.name)).toEqual([
      ORCHESTRATOR_AGENT_NAME,
      'shared-name',
    ]);

    await first.close();
    expect(first.isClosed).toBe(true);
    expect(second.isClosed).toBe(false);
    expect(second.listAgents().agents.map((agent) => agent.name)).toEqual([
      ORCHESTRATOR_AGENT_NAME,
      'shared-name',
    ]);
    secondReservation.release();
    firstReservation.release();
  });

  test('protects immutable list and record snapshots from mutation', async () => {
    const manager = await createManager();
    const reservation = manager.reserveSubagent(reservationRequest('immutable'));
    const listed = manager.listAgents();
    const root = listed.agents[0];
    const subagent = listed.agents[1];
    const snapshot = manager.getAgentSnapshot(reservation.id);

    expect(root).toBeDefined();
    expect(subagent).toBeDefined();
    expect(snapshot).toBeDefined();
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(subagent)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.identity)).toBe(true);
    expect(Reflect.set(root as object, 'name', 'changed')).toBe(false);
    expect(Reflect.set(subagent as object, 'state', 'stopping')).toBe(false);
    expect(Reflect.set(snapshot as object, 'state', 'stopping')).toBe(false);
    expect(Reflect.set(snapshot?.identity as object, 'name', 'changed')).toBe(false);

    expect(manager.listAgents().agents).toEqual(listed.agents);
    expect(manager.getAgentSnapshot(reservation.id)).toEqual(snapshot);
    reservation.release();
  });

  test('does not allow the root lifecycle state to be changed through the subagent seam', async () => {
    const manager = await createManager();

    expect(() =>
      manager.setAgentLifecycleState(manager.orchestratorIdentity.id, 'stopping')
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(manager.listAgents().agents[0]).toMatchObject({
      name: ORCHESTRATOR_AGENT_NAME,
      state: 'running-idle',
    });
  });

  test('removes terminal subagents from authoritative list state without stopping them', async () => {
    const manager = await createManager();
    const reservation = manager.reserveSubagent(reservationRequest('terminal-later'));
    manager.setAgentLifecycleState(reservation.id, 'finishing');
    expect(manager.listAgents().agents.map((agent) => agent.name)).toEqual([
      ORCHESTRATOR_AGENT_NAME,
      'terminal-later',
    ]);
    expect(manager.subagentCount).toBe(1);

    manager.removeTerminalAgent(reservation.id);
    manager.removeTerminalAgent(reservation.id);
    expect(manager.listAgents().agents.map((agent) => agent.name)).toEqual([
      ORCHESTRATOR_AGENT_NAME,
    ]);
    expect(manager.subagentCount).toBe(0);
    expect(manager.getIdentityByName('terminal-later')).toBeUndefined();
    expect(() => manager.removeTerminalAgent(manager.orchestratorIdentity.id)).toThrowError(
      expect.objectContaining({ code: 'invalid_request' })
    );
  });
});

describe('AgentManager names and atomic reservations', () => {
  test('accepts exact one- and 48-character names and rejects 49 characters', async () => {
    const manager = await createManager();
    const shortest = manager.reserveSubagent(reservationRequest('a'));
    const longest = manager.reserveSubagent(reservationRequest('b'.repeat(MAX_AGENT_NAME_LENGTH)));

    expect(shortest.name).toBe('a');
    expect(longest.name).toBe('b'.repeat(MAX_AGENT_NAME_LENGTH));
    expect(() =>
      manager.reserveSubagent(reservationRequest('c'.repeat(MAX_AGENT_NAME_LENGTH + 1)))
    ).toThrowError(expect.objectContaining({ code: 'invalid_name' }));
    expect(manager.subagentCount).toBe(2);
    shortest.release();
    longest.release();
  });

  test('enforces custom name grammar, the reserved name, and exact collisions', async () => {
    const manager = await createManager();
    const invalidNames = [
      '',
      '-agent',
      'agent-',
      'Agent',
      'agent_name',
      'agent name',
      'a'.repeat(MAX_AGENT_NAME_LENGTH + 1),
    ];
    for (const name of invalidNames) {
      expect(() => manager.reserveSubagent(reservationRequest(name))).toThrowError(
        AgentManagerError
      );
      expect(() => manager.reserveSubagent(reservationRequest(name))).toThrowError(
        expect.objectContaining({ code: 'invalid_name' })
      );
    }

    expect(() => manager.reserveSubagent(reservationRequest(ORCHESTRATOR_AGENT_NAME))).toThrowError(
      expect.objectContaining({ code: 'reserved_name' })
    );

    const original = manager.reserveSubagent(reservationRequest('same-name'));
    expect(() => manager.reserveSubagent(reservationRequest('same-name'))).toThrowError(
      expect.objectContaining({ code: 'name_in_use' })
    );
    expect(manager.listAgents().agents.map((agent) => agent.name)).toEqual([
      'orchestrator',
      'same-name',
    ]);
    original.release();
  });

  test('generates typed names, retries collisions, and reports bounded exhaustion', async () => {
    let slugIndex = 0;
    const slugs = ['moss', 'moss', 'river'];
    const manager = await createManager({
      slugGenerator: (): string => slugs[slugIndex++] ?? 'unused',
    });
    const existing = manager.reserveSubagent(reservationRequest('implementer-moss'));
    const generated = manager.reserveSubagent(reservationRequest(undefined));
    expect(generated.name).toBe('implementer-river');
    existing.release();
    generated.release();

    const exhausted = await createManager({
      slugGenerator: (): string => 'same',
      maxAgentNameGenerationAttempts: 2,
    });
    const occupied = exhausted.reserveSubagent(reservationRequest('tester-same'));
    expect(() => exhausted.reserveSubagent(reservationRequest(undefined, 'tester'))).toThrowError(
      expect.objectContaining({ code: 'name_generation_exhausted' })
    );
    occupied.release();
  });

  test('rejects invalid generated slugs and invalid complete generated names', async () => {
    const invalidSlugs: unknown[] = [
      '',
      '-leading',
      'trailing-',
      'Uppercase',
      'contains_underscore',
      'contains space',
      '.',
      'a'.repeat(MAX_AGENT_NAME_LENGTH - 'implementer-'.length + 1),
      null,
      42,
    ];
    let index = 0;
    const manager = await createManager({
      slugGenerator: (): string => invalidSlugs[index++] as string,
      maxAgentNameGenerationAttempts: invalidSlugs.length,
    });

    expect(() => manager.reserveSubagent(reservationRequest(undefined))).toThrowError(
      expect.objectContaining({ code: 'name_generation_exhausted' })
    );
    expect(index).toBe(invalidSlugs.length);
    expect(manager.subagentCount).toBe(0);
    expect(manager.listAgents().agents).toHaveLength(1);
  });

  test('retries invalid generated slugs before accepting a valid complete name', async () => {
    let calls = 0;
    const manager = await createManager({
      slugGenerator: (): string => {
        calls += 1;
        return calls === 1 ? '-invalid' : 'valid';
      },
      maxAgentNameGenerationAttempts: 2,
    });

    const reservation = manager.reserveSubagent(reservationRequest(undefined, 'tester'));
    expect(reservation.name).toBe('tester-valid');
    expect(calls).toBe(2);
    reservation.release();
  });

  test('retries colliding and invalid opaque IDs, then reports bounded ID exhaustion', async () => {
    const generatedIds = ['root-id', 'root-id', '', '..', 'bad/id', 'valid-agent-id'];
    let index = 0;
    const manager = await createManager({
      agentIdGenerator: (): string => generatedIds[index++] ?? 'unused',
      maxAgentIdGenerationAttempts: generatedIds.length,
    });
    const reservation = manager.reserveSubagent(reservationRequest('valid-name'));
    expect(reservation.id).toBe('valid-agent-id');
    expect(index).toBe(generatedIds.length);
    reservation.release();

    const exhaustedIds = ['another-root', 'another-root', 'another-root', 'unused-agent'];
    let exhaustedIndex = 0;
    const exhausted = await createManager({
      agentIdGenerator: (): string => exhaustedIds[exhaustedIndex++] ?? 'unused',
      maxAgentIdGenerationAttempts: 2,
    });
    expect(() => exhausted.reserveSubagent(reservationRequest('not-allocated'))).toThrowError(
      expect.objectContaining({ code: 'identity_generation_exhausted' })
    );
    expect(exhausted.subagentCount).toBe(0);
    const retry = exhausted.reserveSubagent(reservationRequest('allocated-after-retry'));
    expect(retry.id).toBe('unused-agent');
    retry.release();
  });

  test('holds exactly eight nonterminal reservations and releases names and slots idempotently', async () => {
    const manager = await createManager();
    const reservations = Array.from({ length: MAX_SUBAGENTS_PER_SESSION }, (_, index) =>
      manager.reserveSubagent(reservationRequest(`worker-${index}`))
    );
    expect(manager.subagentCount).toBe(MAX_SUBAGENTS_PER_SESSION);
    expect(() => manager.reserveSubagent(reservationRequest('ninth'))).toThrowError(
      expect.objectContaining({ code: 'agent_limit_reached' })
    );

    reservations[0]?.release();
    reservations[0]?.release();
    expect(manager.subagentCount).toBe(MAX_SUBAGENTS_PER_SESSION - 1);
    const replacement = manager.reserveSubagent(reservationRequest('ninth'));
    expect(manager.subagentCount).toBe(MAX_SUBAGENTS_PER_SESSION);
    replacement.release();
    for (const reservation of reservations.slice(1)) {
      reservation.release();
    }
    expect(manager.subagentCount).toBe(0);
  });

  test('atomically competes for the final slot when starts are scheduled together', async () => {
    const manager = await createManager();
    const initial = Array.from({ length: MAX_SUBAGENTS_PER_SESSION - 1 }, (_, index) =>
      manager.reserveSubagent(reservationRequest(`existing-${index}`))
    );
    const results = await Promise.allSettled(
      Array.from({ length: 32 }, (_, index) => `last-${index}`).map(async (name) =>
        manager.reserveSubagent(reservationRequest(name))
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(31);
    expect(manager.subagentCount).toBe(MAX_SUBAGENTS_PER_SESSION);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        result.value.release();
      }
    }
    for (const reservation of initial) {
      reservation.release();
    }
  });

  test('counts finishing and stopping reservations and preserves stable IDs across state changes', async () => {
    const manager = await createManager();
    const finishing = manager.reserveSubagent(reservationRequest('finishing'));
    const stopping = manager.reserveSubagent(reservationRequest('stopping'));
    manager.setAgentLifecycleState(finishing.id, 'finishing');
    manager.setAgentLifecycleState(stopping.id, 'stopping');

    expect(manager.subagentCount).toBe(2);
    expect(manager.listAgents().agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'finishing', id: finishing.id, state: 'finishing' }),
        expect.objectContaining({ name: 'stopping', id: stopping.id, state: 'stopping' }),
      ])
    );
    expect(manager.getAgentSnapshot(finishing.id)?.identity.id).toBe(finishing.id);
    finishing.release();
    stopping.release();
  });

  test('counts every nonterminal state toward the capacity limit', async () => {
    const manager = await createManager();
    const states = [
      'starting',
      'running-active',
      'running-idle',
      'finishing',
      'stopping',
      'starting',
      'running-active',
      'running-idle',
    ] as const;
    const reservations = states.map((state, index) => {
      const reservation = manager.reserveSubagent(reservationRequest(`state-${index}`));
      manager.setAgentLifecycleState(reservation.id, state);
      return reservation;
    });

    expect(manager.subagentCount).toBe(MAX_SUBAGENTS_PER_SESSION);
    expect(manager.listAgents().agents.map((agent) => agent.state)).toEqual([
      'running-idle',
      ...states,
    ]);
    expect(() => manager.reserveSubagent(reservationRequest('over-capacity'))).toThrowError(
      expect.objectContaining({ code: 'agent_limit_reached' })
    );
    for (const reservation of reservations) {
      reservation.release();
    }
    expect(manager.subagentCount).toBe(0);
  });

  test('does not consume capacity or replace the target on a custom-name collision', async () => {
    const manager = await createManager();
    const original = manager.reserveSubagent(reservationRequest('collision-target'));

    expect(() => manager.reserveSubagent(reservationRequest('collision-target'))).toThrowError(
      expect.objectContaining({ code: 'name_in_use' })
    );
    expect(manager.subagentCount).toBe(1);
    expect(manager.getIdentityByName('collision-target')).toMatchObject({
      id: original.id,
      name: original.name,
    });
    expect(manager.listAgents().agents).toHaveLength(2);
    original.release();
  });
});

describe('AgentManager StartAgent startup and rollback', () => {
  test('requires availability notifications on orchestrator and launched input adapters', async () => {
    const invalidInput = {
      ready: Promise.resolve(),
      isReady: true,
      activity: 'idle',
      deliver: (): 'steered' => 'steered',
    };

    await expect(
      createAgentManager({ orchestratorInputAdapter: invalidInput as never })
    ).rejects.toMatchObject({ code: 'invalid_options' });

    const launcher = {
      launch: async (request: AgentLaunchRequest) => ({
        executor: request.identity.executor,
        processLabel: request.processLabel,
        input: invalidInput,
        ready: Promise.resolve(),
        completion: new Promise<never>(() => undefined),
      }),
    };
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher as never,
    });

    await expect(
      manager.startAgent(manager.orchestratorIdentity, reservationRequest('invalid-input'))
    ).rejects.toMatchObject({ code: 'launch_failed' });
    expect(manager.subagentCount).toBe(0);
    expect(manager.getIdentityByName('invalid-input')).toBeUndefined();
  });

  test('authorizes the registered orchestrator before validation, name generation, or allocation', async () => {
    const launcher = new FakeAgentLauncher();
    const preparer = createPreparer();
    const slugGenerator = vi.fn((): string => 'unused');
    const manager = await createManager({
      agentPreparer: preparer,
      agentLauncher: launcher,
      slugGenerator,
    });

    await expect(
      manager.startAgent({ ...manager.orchestratorIdentity, name: 'forged-root' } as never, {
        type: 'implementer',
        executor: 'codex-cli',
        initialMessage: 42,
      })
    ).rejects.toMatchObject({ code: 'not_authorized' });
    expect(manager.subagentCount).toBe(0);
    expect(manager.listAgents().agents).toHaveLength(1);
    expect(slugGenerator).not.toHaveBeenCalled();
    expect(preparer.requests).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);
  });

  test.each([
    undefined,
    {
      id: 'stale-root',
      name: ORCHESTRATOR_AGENT_NAME,
      role: 'orchestrator',
      executor: 'claude-code',
    },
    { id: 'agent-id-1', name: ORCHESTRATOR_AGENT_NAME, role: 'subagent', executor: 'claude-code' },
    {
      id: 'agent-id-1',
      name: ORCHESTRATOR_AGENT_NAME,
      role: 'orchestrator',
      executor: 'codex-cli',
    },
    { id: 'agent-id-1', name: 'forged-root', role: 'orchestrator', executor: 'claude-code' },
  ])('rejects a caller that is not the authoritative orchestrator identity: %j', async (caller) => {
    const launcher = new FakeAgentLauncher();
    const preparer = createPreparer();
    const manager = await createManager({ agentPreparer: preparer, agentLauncher: launcher });

    await expect(
      manager.startAgent(caller as never, {
        type: 'unsupported',
        executor: 'invalid',
        initialMessage: 42,
      })
    ).rejects.toMatchObject({ code: 'not_authorized' });
    expect(manager.listAgents().agents).toHaveLength(1);
    expect(preparer.requests).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);
  });

  test('rejects a registered subagent caller before validating the StartAgent request', async () => {
    const launcher = new FakeAgentLauncher();
    const preparer = createPreparer();
    const manager = await createManager({ agentPreparer: preparer, agentLauncher: launcher });
    const subagent = manager.reserveSubagent(reservationRequest('subagent-caller'));

    await expect(
      manager.startAgent(subagent.identity, {
        type: 'unsupported',
        executor: 'invalid',
        initialMessage: 42,
      })
    ).rejects.toMatchObject({ code: 'not_authorized' });
    expect(manager.subagentCount).toBe(1);
    expect(preparer.requests).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);
    subagent.release();
  });

  test.each([
    ['implementer', 'claude-code'],
    ['tester', 'codex-cli'],
    ['tdd-tests', 'claude-code'],
    ['reviewer', 'codex-cli'],
  ] as const)('starts a %s with the exact %s inputs and named label', async (type, executor) => {
    const launcher = new FakeAgentLauncher();
    const preparer = createPreparer();
    const manager = await createManager({ agentPreparer: preparer, agentLauncher: launcher });
    const request = {
      name: `${type}-agent`,
      type,
      executor,
      initialMessage: `Initial ${type} instructions`,
    } as const;

    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager.startAgent(manager.orchestratorIdentity, request);
    const launch = await launchPromise;
    expect(startPromise).toBeInstanceOf(Promise);
    launch.handle.markReady();
    const result = await startPromise;

    const registrations = await manager.sessionRuntime.runtime.listRegistrations();
    expect(registrations).toHaveLength(2);
    expect(registrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: result.id,
          name: request.name,
          role: 'subagent',
          state: 'starting',
        }),
      ])
    );
    const registration = registrations.find((entry) => entry.id === result.id);
    expect(registration?.socketPath).toBeDefined();
    await expect(fs.stat(registration?.socketPath as string)).resolves.toBeTruthy();

    expect(result).toMatchObject({
      name: request.name,
      id: launch?.request.identity.id,
      type,
      executor,
      state: 'starting',
    });
    expect(preparer.requests[0]).toMatchObject({
      identity: { id: result.id, name: request.name, type, executor },
      initialMessage: request.initialMessage,
    });
    expect(launch?.request).toMatchObject({
      identity: { id: result.id, name: request.name, type, executor },
      initialMessage: request.initialMessage,
      processLabel:
        executor === 'claude-code'
          ? `Claude agent (${request.name})`
          : `Codex thread (${request.name})`,
    });
    expect(launch?.request.preparedExecution.agentType).toBe(type);

    const listed = manager.listAgents().agents;
    expect(listed[1]).toMatchObject({ ...result, role: 'subagent' });
    expect(manager.getAgentSnapshot(result.id)?.identity.id).toBe(result.id);
    expect(manager.getAgentSnapshot(result.id)?.processControlId).toBe(
      launch?.handle.processControlId
    );
    expect(manager.getAgentSnapshot(result.id)?.providerThreadId).toBe(
      launch?.handle.providerThreadId
    );

    launch?.handle.input.markReady();
    await waitFor(() => manager.listAgents().agents[1]?.state === 'running-idle');
    expect(manager.getAgentSnapshot(result.id)?.identity.id).toBe(result.id);
    expect(launch?.handle.completion).toBeInstanceOf(Promise);
    expect(launch?.handle.isReleased).toBe(false);
  });

  test('returns after handle readiness without waiting for input readiness or completion', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });

    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager.startAgent(
      manager.orchestratorIdentity,
      reservationRequest('nonblocking')
    );
    const launch = await launchPromise;
    expect(launch.handle.input.isReady).toBe(false);
    launch.handle.markReady();

    const result = await startPromise;
    expect(result.state).toBe('starting');
    expect(launch?.handle.input.isReady).toBe(false);
    expect(manager.listAgents().agents[1]?.state).toBe('starting');

    launch?.handle.input.markReady();
    await waitFor(() => manager.listAgents().agents[1]?.state === 'running-idle');
    expect(manager.getAgentSnapshot(result.id)?.identity.id).toBe(result.id);
  });

  test('does not publish running state when input readiness precedes launch readiness', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager.startAgent(
      manager.orchestratorIdentity,
      reservationRequest('launch-boundary')
    );
    const launch = await launchPromise;

    launch.handle.input.markReady();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manager.listAgents().agents[1]?.state).toBe('starting');

    const acknowledgement = await manager.sessionRuntime.sendMessage(
      { id: manager.orchestratorIdentity.id, name: manager.orchestratorIdentity.name },
      { id: launch.request.identity.id, name: launch.request.identity.name },
      { requestId: 'launch-boundary-message', content: 'wait for launch readiness' }
    );
    expect(acknowledgement).toMatchObject({ success: true, delivery: 'queued' });
    expect(launch.handle.input.receivedMessages).toHaveLength(0);

    launch.handle.markReady();
    await expect(startPromise).resolves.toMatchObject({
      name: 'launch-boundary',
      state: 'running-idle',
    });
    expect(manager.listAgents().agents[1]?.state).toBe('running-active');
    expect(launch.handle.input.receivedMessages[0]?.content).toBe('wait for launch readiness');
  });

  test('keeps starting mailbox delivery queue-safe before an input adapter is ready', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager.startAgent(
      manager.orchestratorIdentity,
      reservationRequest('mailbox-starting')
    );
    const launch = await launchPromise;

    const acknowledgement = await manager.sessionRuntime.sendMessage(
      { id: manager.orchestratorIdentity.id, name: manager.orchestratorIdentity.name },
      { id: launch.request.identity.id, name: launch.request.identity.name },
      { requestId: 'starting-message-1', content: 'queued during startup' }
    );
    expect(acknowledgement).toMatchObject({ success: true, delivery: 'queued' });
    expect(launch.handle.input.receivedMessages).toHaveLength(0);
    expect(manager.getAgentSnapshot(launch.request.identity.id)?.state).toBe('starting');
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toBeDefined();

    launch.handle.markReady();
    await startPromise;
    expect(launch.handle.input.isReady).toBe(false);
    expect(manager.getAgentSnapshot(launch.request.identity.id)?.state).toBe('starting');
  });

  test('rolls back preparation failure and reuses the name and capacity', async () => {
    const launcher = new FakeAgentLauncher();
    const preparer = createPreparer();
    preparer.setNextPreparationFailure();
    const manager = await createManager({ agentPreparer: preparer, agentLauncher: launcher });

    await expect(
      manager.startAgent(manager.orchestratorIdentity, reservationRequest('retry-preparation'))
    ).rejects.toMatchObject({ code: 'launch_failed' });
    expect(manager.subagentCount).toBe(0);
    expect(manager.listAgents().agents).toHaveLength(1);

    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager.startAgent(
      manager.orchestratorIdentity,
      reservationRequest('retry-preparation')
    );
    const launch = await launchPromise;
    launch.handle.markReady();
    await expect(startPromise).resolves.toMatchObject({ name: 'retry-preparation' });
  });

  test('rolls back launch failure and releases the prepared mailbox', async () => {
    const launcher = new FakeAgentLauncher();
    launcher.setNextLaunchFailure();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });

    await expect(
      manager.startAgent(manager.orchestratorIdentity, reservationRequest('retry-launch'))
    ).rejects.toMatchObject({ code: 'launch_failed' });
    expect(manager.subagentCount).toBe(0);
    expect(manager.listAgents().agents).toHaveLength(1);

    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager.startAgent(
      manager.orchestratorIdentity,
      reservationRequest('retry-launch')
    );
    const launch = await launchPromise;
    launch.handle.markReady();
    await expect(startPromise).resolves.toMatchObject({ name: 'retry-launch' });
  });

  test('rolls back readiness failure and releases the provider handle', async () => {
    const launcher = new FakeAgentLauncher();
    launcher.setNextReadinessFailure();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });

    await expect(
      manager.startAgent(manager.orchestratorIdentity, reservationRequest('retry-ready'))
    ).rejects.toMatchObject({ code: 'launch_failed' });
    expect(launcher.launches[0]?.handle.isReleased).toBe(true);
    expect(manager.subagentCount).toBe(0);
    expect(manager.listAgents().agents).toHaveLength(1);

    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager.startAgent(
      manager.orchestratorIdentity,
      reservationRequest('retry-ready')
    );
    const launch = await launchPromise;
    launch.handle.markReady();
    await expect(startPromise).resolves.toMatchObject({ name: 'retry-ready' });
  });

  test('rolls back a real mailbox socket readiness failure and reuses the slot and name', async () => {
    const launcher = new FakeAgentLauncher();
    const ids = ['root-id', 'blocked-mailbox-id', 'retry-mailbox-id'];
    const manager = await createManager({
      agentIdGenerator: () => ids.shift() ?? 'unused-id',
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const blockedSocketPath = manager.sessionRuntime.runtime.socketPath('blocked-mailbox-id');
    await fs.writeFile(blockedSocketPath, 'socket path is occupied');

    await expect(
      manager.startAgent(manager.orchestratorIdentity, reservationRequest('retry-mailbox'))
    ).rejects.toMatchObject({ code: 'launch_failed' });
    expect(manager.subagentCount).toBe(0);
    expect(manager.listAgents().agents).toHaveLength(1);
    expect(launcher.launches).toHaveLength(0);
    await expect(fs.stat(blockedSocketPath)).resolves.toBeTruthy();
    expect(await manager.sessionRuntime.runtime.listRegistrations()).toHaveLength(1);

    await fs.unlink(blockedSocketPath);
    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager.startAgent(
      manager.orchestratorIdentity,
      reservationRequest('retry-mailbox')
    );
    const launch = await launchPromise;
    launch.handle.markReady();
    await expect(startPromise).resolves.toMatchObject({
      name: 'retry-mailbox',
      id: 'retry-mailbox-id',
    });
  });

  test('releases a handle once and preserves reservation cleanup when handle release fails', async () => {
    const launcher = new FakeAgentLauncher();
    launcher.setNextReadinessFailure();
    launcher.setNextReleaseFailure();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });

    await expect(
      manager.startAgent(manager.orchestratorIdentity, reservationRequest('release-error'))
    ).rejects.toMatchObject({ code: 'launch_failed' });
    const failedLaunch = launcher.launches[0];
    expect(failedLaunch?.handle.isReleased).toBe(true);
    expect(failedLaunch?.handle.releaseCount).toBe(1);
    expect(manager.subagentCount).toBe(0);
    expect(manager.getIdentityByName('release-error')).toBeUndefined();

    await failedLaunch?.handle.release();
    expect(failedLaunch?.handle.releaseCount).toBe(1);

    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager.startAgent(
      manager.orchestratorIdentity,
      reservationRequest('release-error')
    );
    const launch = await launchPromise;
    launch.handle.markReady();
    await expect(startPromise).resolves.toMatchObject({ name: 'release-error' });
  });

  test('does not let mailbox cleanup affect another active identity', async () => {
    const launcher = new FakeAgentLauncher();
    const preparer = createPreparer();
    const ids = ['root-id', 'occupied-id', 'active-id'];
    const manager = await createManager({
      agentIdGenerator: () => ids.shift() ?? 'unused-id',
      agentPreparer: preparer,
      agentLauncher: launcher,
    });
    const external = await manager.sessionRuntime.register({
      registration: {
        id: 'occupied-id',
        name: 'external-agent',
        role: 'subagent',
        type: 'tester',
        executor: 'codex-cli',
        state: 'starting',
      },
      deliver: async (): Promise<'temporarily-unavailable'> => 'temporarily-unavailable',
    });

    await expect(
      manager.startAgent(manager.orchestratorIdentity, reservationRequest('mailbox-conflict'))
    ).rejects.toMatchObject({ code: 'launch_failed' });
    expect(manager.subagentCount).toBe(0);
    expect(await manager.sessionRuntime.runtime.listRegistrations()).toHaveLength(2);
    await expect(fs.stat(external.registration.socketPath)).resolves.toBeTruthy();

    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager.startAgent(
      manager.orchestratorIdentity,
      reservationRequest('mailbox-conflict')
    );
    const launch = await launchPromise;
    launch.handle.markReady();
    await expect(startPromise).resolves.toMatchObject({ name: 'mailbox-conflict' });
    await external.deregister();
  });

  test('does not let a removed identity release a later reused name or slot', async () => {
    const manager = await createManager();
    const first = manager.reserveSubagent(reservationRequest('reused-name'));
    const oldId = first.id;
    manager.removeTerminalAgent(oldId);

    const second = manager.reserveSubagent(reservationRequest('reused-name', 'reviewer'));
    expect(second.id).not.toBe(oldId);
    manager.removeTerminalAgent(oldId);
    expect(manager.getIdentityByName('reused-name')).toMatchObject({
      id: second.id,
      type: 'reviewer',
    });
    expect(manager.subagentCount).toBe(1);

    first.release();
    expect(manager.getIdentityByName('reused-name')).toMatchObject({ id: second.id });
    second.release();
    expect(manager.subagentCount).toBe(0);
  });

  test('waits for mailbox cleanup before reuse without waiting for provider cleanup', async () => {
    const session = await createAgentMessagingSessionRuntime();
    const launcher = new FakeAgentLauncher();
    launcher.setNextReadinessFailure();
    launcher.setNextReleasePending();
    let manager: AgentManager | undefined;
    let releaseDeregister: () => void = () => undefined;
    const deregisterStarted = new Promise<void>((resolve) => {
      const allowDeregister = new Promise<void>((resolveAllow) => {
        releaseDeregister = resolveAllow;
      });
      const originalRegister = session.register.bind(session);
      vi.spyOn(session, 'register').mockImplementation(async (options) => {
        const registration = await originalRegister(options);
        if (options.registration.name !== 'hanging-cleanup') {
          return registration;
        }
        const originalDeregister = registration.deregister.bind(registration);
        registration.deregister = async (): Promise<void> => {
          resolve();
          await allowDeregister;
          await originalDeregister();
        };
        return registration;
      });
    });

    try {
      manager = await createManager({
        sessionRuntime: session,
        agentPreparer: createPreparer(),
        agentLauncher: launcher,
      });

      const failedStart = manager.startAgent(
        manager.orchestratorIdentity,
        reservationRequest('hanging-cleanup')
      );
      const failedLaunch = await launcher.waitForNextLaunch();
      await deregisterStarted;

      expect(manager.subagentCount).toBe(1);
      expect(manager.getIdentityByName('hanging-cleanup')).toBeDefined();
      expect(failedLaunch.handle.releaseCount).toBe(1);

      await expect(
        manager.startAgent(manager.orchestratorIdentity, reservationRequest('hanging-cleanup'))
      ).rejects.toMatchObject({ code: 'name_in_use' });

      releaseDeregister();
      await expect(failedStart).rejects.toMatchObject({ code: 'launch_failed' });
      expect(manager.subagentCount).toBe(0);
      expect(manager.getIdentityByName('hanging-cleanup')).toBeUndefined();

      const retryLaunchPromise = launcher.waitForNextLaunch();
      const retryStart = manager.startAgent(
        manager.orchestratorIdentity,
        reservationRequest('hanging-cleanup')
      );
      const retryLaunch = await retryLaunchPromise;
      retryLaunch.handle.markReady();
      await expect(retryStart).resolves.toMatchObject({ name: 'hanging-cleanup' });

      failedLaunch.handle.resolveRelease();
    } finally {
      await manager?.close().catch(() => undefined);
      await session.close();
    }
  });
});

describe('AgentManager SendAgentMessage routing', () => {
  test('routes trusted orchestrator, peer, and subagent messages through real mailboxes', async () => {
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      orchestratorInputAdapter: rootInput,
    });
    const first = await startFakeAgent(manager, launcher, 'first-worker');
    const second = await startFakeAgent(manager, launcher, 'second-worker');
    first.handle.input.markReady();
    second.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(first.request.identity.id)?.state === 'running-idle'
    );
    await waitFor(
      () => manager.getAgentSnapshot(second.request.identity.id)?.state === 'running-idle'
    );

    first.handle.input.setActiveAccepting();
    const steered = await manager.sendAgentMessage(manager.orchestratorIdentity, {
      name: 'first-worker',
      message: 'orchestrator steering',
    });
    expect(steered).toMatchObject({
      name: 'first-worker',
      delivery: 'steered',
    });
    expect(steered.messageId).toBe(first.handle.input.receivedMessages[0]?.messageId);
    expect(first.handle.input.receivedMessages[0]).toMatchObject({
      source: { id: manager.orchestratorIdentity.id, name: ORCHESTRATOR_AGENT_NAME },
      content: 'orchestrator steering',
    });

    const firstIdentity = manager.getIdentityByName('first-worker');
    const secondIdentity = manager.getIdentityByName('second-worker');
    expect(firstIdentity?.role).toBe('subagent');
    expect(secondIdentity?.role).toBe('subagent');

    const peer = await manager.sendAgentMessage(firstIdentity as never, {
      name: 'second-worker',
      message: 'peer handoff',
    });
    expect(peer.delivery).toBe('started-idle-turn');
    expect(second.handle.input.receivedMessages[0]).toMatchObject({
      source: { name: 'first-worker', id: first.request.identity.id },
      content: 'peer handoff',
    });

    const reply = await manager.sendAgentMessage(secondIdentity as never, {
      name: 'orchestrator',
      message: 'reply to root',
    });
    expect(reply.delivery).toBe('started-idle-turn');
    expect(rootInput.receivedMessages[0]).toMatchObject({
      source: { name: 'second-worker', id: second.request.identity.id },
      content: 'reply to root',
    });
  });

  test('rejects forged callers and source fields before transport work', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const target = await startFakeAgent(manager, launcher, 'spoof-target');
    target.handle.input.markReady();

    await expect(
      manager.sendAgentMessage({ ...manager.orchestratorIdentity, name: 'spoofed-root' } as never, {
        name: 'spoof-target',
        message: 'must not send',
      })
    ).rejects.toMatchObject({ code: 'unknown_sender' });
    await expect(
      manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'spoof-target',
        message: 'must reject source field',
        source: 'spoofed-root',
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(target.handle.input.receivedMessages).toHaveLength(0);
  });

  test('queues temporary input and drains one mailbox FIFO when input becomes available', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const target = await startFakeAgent(manager, launcher, 'queued-target');
    target.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(target.request.identity.id)?.state === 'running-idle'
    );
    target.handle.input.setTemporarilyUnavailable();

    const queued = [];
    for (const message of ['one', 'two', 'three']) {
      queued.push(
        await manager.sendAgentMessage(manager.orchestratorIdentity, {
          name: 'queued-target',
          message,
        })
      );
    }
    expect(queued.map((result) => result.delivery)).toEqual(['queued', 'queued', 'queued']);
    expect(target.handle.input.receivedMessages).toHaveLength(0);
    await expect(manager.sessionRuntime.runtime.listRegistrations()).resolves.toHaveLength(2);

    target.handle.input.setActiveAccepting();
    await waitFor(() => target.handle.input.receivedMessages.length === 3);
    expect(target.handle.input.receivedMessages.map((message) => message.content)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(target.handle.input.receivedMessages.map((message) => message.messageId)).toEqual(
      queued.map((result) => result.messageId)
    );
  });

  test('retries one temporary delivery at a safe point without an activity transition', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const target = await startFakeAgent(manager, launcher, 'temporary-retry-target');
    target.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(target.request.identity.id)?.state === 'running-idle'
    );
    target.handle.input.setTemporarilyUnavailable();
    const queued = await Promise.all(
      ['first', 'second'].map((message) =>
        manager.sendAgentMessage(manager.orchestratorIdentity, {
          name: 'temporary-retry-target',
          message,
        })
      )
    );
    expect(queued.map((result) => result.delivery)).toEqual(['queued', 'queued']);

    const deliveryStarted = target.handle.input.deferNextDelivery();
    target.handle.input.setActiveAccepting();
    expect(target.handle.input.isReady).toBe(true);
    expect(target.handle.input.activity).toBe('active');
    expect(manager.getAgentSnapshot(target.request.identity.id)?.state).toBe('running-active');
    await deliveryStarted;
    target.handle.input.resolveNextDelivery('temporarily-unavailable');

    await waitFor(() => target.handle.input.receivedMessages.length === 2);
    expect(target.handle.input.receivedMessages.map((message) => message.content)).toEqual([
      'first',
      'second',
    ]);
  });

  test('drains queued messages from a removed sender without blocking later FIFO work', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const sender = await startFakeAgent(manager, launcher, 'removed-sender');
    sender.handle.input.markReady();
    const target = await startFakeAgent(manager, launcher, 'dead-sender-target');
    target.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(target.request.identity.id)?.state === 'running-idle'
    );
    target.handle.input.setTemporarilyUnavailable();

    await expect(
      manager.sendAgentMessage(sender.request.identity, {
        name: 'dead-sender-target',
        message: 'from removed sender',
      })
    ).resolves.toMatchObject({ delivery: 'queued' });

    manager.removeTerminalAgent(sender.request.identity.id);
    await manager.sessionRuntime.deregister(sender.request.identity.id);

    await expect(
      manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'dead-sender-target',
        message: 'from orchestrator after removal',
      })
    ).resolves.toMatchObject({ delivery: 'queued' });

    target.handle.input.setActiveAccepting();
    await waitFor(() => target.handle.input.receivedMessages.length === 2);
    expect(target.handle.input.receivedMessages.map((message) => message.content)).toEqual([
      'from removed sender',
      'from orchestrator after removal',
    ]);
    expect(target.handle.input.receivedMessages.map((message) => message.source.name)).toEqual([
      'removed-sender',
      'orchestrator',
    ]);
  });

  test('preserves concurrent per-recipient order through the real mailbox', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const target = await startFakeAgent(manager, launcher, 'concurrent-target');
    target.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(target.request.identity.id)?.state === 'running-idle'
    );
    target.handle.input.setTemporarilyUnavailable();

    const sends = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        manager.sendAgentMessage(manager.orchestratorIdentity, {
          name: 'concurrent-target',
          message: `concurrent-${index}`,
        })
      )
    );
    expect(sends.every((result) => result.delivery === 'queued')).toBe(true);

    target.handle.input.setActiveAccepting();
    await waitFor(() => target.handle.input.receivedMessages.length === sends.length);
    expect(target.handle.input.receivedMessages.map((message) => message.content)).toEqual(
      Array.from({ length: sends.length }, (_, index) => `concurrent-${index}`)
    );
  });

  test('does not lose or reorder a message when availability changes during a drain', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const target = await startFakeAgent(manager, launcher, 'drain-race-target');
    target.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(target.request.identity.id)?.state === 'running-idle'
    );
    target.handle.input.setTemporarilyUnavailable();
    for (const message of ['one', 'two', 'three']) {
      await manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'drain-race-target',
        message,
      });
    }

    target.handle.input.deferNextDelivery();
    target.handle.input.setActiveAccepting();
    const fourth = manager.sendAgentMessage(manager.orchestratorIdentity, {
      name: 'drain-race-target',
      message: 'four',
    });
    target.handle.input.setTemporarilyUnavailable();
    target.handle.input.resolveNextDelivery('temporarily-unavailable');

    expect((await fourth).delivery).toBe('queued');
    expect(target.handle.input.receivedMessages).toHaveLength(0);

    target.handle.input.setActiveAccepting();
    await waitFor(() => target.handle.input.receivedMessages.length === 4);
    expect(target.handle.input.receivedMessages.map((message) => message.content)).toEqual([
      'one',
      'two',
      'three',
      'four',
    ]);
  });

  test('counts a provider delivery reservation against the 100-message mailbox limit', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const target = await startFakeAgent(manager, launcher, 'drain-capacity-target');
    target.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(target.request.identity.id)?.state === 'running-idle'
    );
    target.handle.input.setTemporarilyUnavailable();
    for (let index = 0; index < MAX_PENDING_MESSAGES_PER_RECIPIENT; index += 1) {
      await manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'drain-capacity-target',
        message: `queued-${index}`,
      });
    }

    target.handle.input.deferNextDelivery();
    target.handle.input.setActiveAccepting();
    await expect(
      manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'drain-capacity-target',
        message: 'must-not-overflow-reservation',
      })
    ).rejects.toMatchObject({ code: 'transport_error', transportCode: 'queue_full' });

    target.handle.input.resolveNextDelivery('steered');
    await waitFor(
      () => target.handle.input.receivedMessages.length === MAX_PENDING_MESSAGES_PER_RECIPIENT
    );
    expect(target.handle.input.receivedMessages.map((message) => message.content)).toEqual(
      Array.from({ length: MAX_PENDING_MESSAGES_PER_RECIPIENT }, (_, index) => `queued-${index}`)
    );
  });

  test('queues during starting and drains after both launch and input readiness', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager.startAgent(
      manager.orchestratorIdentity,
      reservationRequest('starting-queue', 'implementer')
    );
    const launch = await launchPromise;
    const queued = await manager.sendAgentMessage(manager.orchestratorIdentity, {
      name: 'starting-queue',
      message: 'arrived during startup',
    });
    expect(queued.delivery).toBe('queued');
    expect(launch.handle.input.receivedMessages).toHaveLength(0);

    launch.handle.input.markReady();
    launch.handle.markReady();
    await expect(startPromise).resolves.toMatchObject({
      name: 'starting-queue',
      state: 'running-idle',
    });
    await waitFor(() => launch.handle.input.receivedMessages.length === 1);
    expect(launch.handle.input.receivedMessages[0]).toMatchObject({
      messageId: queued.messageId,
      content: 'arrived during startup',
      source: { name: 'orchestrator' },
    });
  });

  test('returns the idle-turn disposition and enforces exact message and queue limits', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const target = await startFakeAgent(manager, launcher, 'limit-target');
    target.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(target.request.identity.id)?.state === 'running-idle'
    );

    const idle = await manager.sendAgentMessage(manager.orchestratorIdentity, {
      name: 'limit-target',
      message: 'idle turn',
    });
    expect(idle.delivery).toBe('started-idle-turn');

    target.handle.input.setTemporarilyUnavailable();
    const exactMessage = '🙂'.repeat(MAX_AGENT_MESSAGE_BYTES / 4);
    const exact = await manager.sendAgentMessage(manager.orchestratorIdentity, {
      name: 'limit-target',
      message: exactMessage,
    });
    expect(exact.delivery).toBe('queued');
    await expect(
      manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'limit-target',
        message: `${exactMessage}x`,
      })
    ).rejects.toMatchObject({ code: 'invalid_request', transportCode: 'message_too_large' });

    const queued = [];
    for (let index = 0; index < MAX_PENDING_MESSAGES_PER_RECIPIENT - 1; index += 1) {
      queued.push(
        await manager.sendAgentMessage(manager.orchestratorIdentity, {
          name: 'limit-target',
          message: `queued-${index}`,
        })
      );
    }
    expect(queued).toHaveLength(MAX_PENDING_MESSAGES_PER_RECIPIENT - 1);
    await expect(
      manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'limit-target',
        message: 'queue-overflow',
      })
    ).rejects.toMatchObject({ code: 'transport_error', transportCode: 'queue_full' });
    expect(target.handle.input.receivedMessages).toHaveLength(1);

    target.handle.input.setActiveAccepting();
    await waitFor(
      () => target.handle.input.receivedMessages.length === MAX_PENDING_MESSAGES_PER_RECIPIENT + 1
    );
    expect(target.handle.input.receivedMessages.slice(1).map((message) => message.content)).toEqual(
      [exactMessage, ...queued.map((result) => `queued-${queued.indexOf(result)}`)]
    );
  });

  test('rejects lifecycle, stale, and transport failures with stable manager codes', async () => {
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      orchestratorInputAdapter: rootInput,
    });
    const finishing = await startFakeAgent(manager, launcher, 'finishing-target');
    finishing.handle.input.markReady();
    const stopping = await startFakeAgent(manager, launcher, 'stopping-target');
    stopping.handle.input.markReady();
    manager.setAgentLifecycleState(finishing.request.identity.id, 'finishing');
    manager.setAgentLifecycleState(stopping.request.identity.id, 'stopping');

    for (const name of ['finishing-target', 'stopping-target']) {
      await expect(
        manager.sendAgentMessage(manager.orchestratorIdentity, { name, message: 'rejected' })
      ).rejects.toMatchObject({ code: 'target_not_accepting_messages' });
    }
    await expect(
      manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'missing-target',
        message: 'unknown',
      })
    ).rejects.toMatchObject({ code: 'unknown_target' });

    const staleSender = manager.getIdentityByName('stopping-target');
    manager.removeTerminalAgent(stopping.request.identity.id);
    await expect(
      manager.sendAgentMessage(staleSender as never, {
        name: 'orchestrator',
        message: 'stale sender',
      })
    ).rejects.toMatchObject({ code: 'unknown_sender' });

    const staleTarget = await startFakeAgent(manager, launcher, 'stale-target');
    staleTarget.handle.input.markReady();
    await manager.sessionRuntime.deregister(staleTarget.request.identity.id);
    await expect(
      manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'stale-target',
        message: 'stale registration',
      })
    ).rejects.toMatchObject({ code: 'unknown_target', transportCode: 'unknown_target' });
  });
});

describe('provider-neutral launch contracts and test fakes', () => {
  test('keeps collaborative reviewer preparation behind a narrow injected seam', async () => {
    const manager = await createManager();
    const reservation = manager.reserveSubagent(
      reservationRequest('reviewer-prepared', 'reviewer')
    );
    const reviewerPreparation = createAgentPreparation({
      planId: 1,
      prepareReviewer: async (request): Promise<PreparedAgentExecution> =>
        preparedExecutionFor(request),
    });

    const prepared = await reviewerPreparation.prepare({
      identity: reservation.identity,
      initialMessage: 'Review without mutating the workspace.',
    });

    expect(prepared.agentType).toBe('reviewer');
    expect(prepared.executor).toBe('codex-cli');
    reservation.release();
  });

  test('accepts reviewer prepared executions in launch requests', async () => {
    const manager = await createManager();
    const reservation = manager.reserveSubagent(reservationRequest('reviewer-agent', 'reviewer'));
    const preparedExecution = {
      agentType: 'reviewer',
      executor: 'codex-cli',
      model: undefined,
      plan: {
        id: 1,
        title: 'Review plan',
        status: 'pending',
        tasks: [],
      },
      planId: 1,
      planPath: '/tmp/review-plan.md',
      gitRoot: '/tmp/repo',
      useJj: false,
      prompt: 'Review the current changes.',
      config: getDefaultConfig(),
      timEnvironment: { context: {} },
    } satisfies PreparedAgentExecution;
    const legacyPreparedExecution = {
      ...preparedExecution,
      agentType: 'implementer',
    } satisfies PreparedSubagentExecution;
    const widenedPreparedExecution: PreparedAgentExecution = legacyPreparedExecution;
    const reviewerLaunchRequest = {
      identity: reservation.identity,
      initialMessage: 'Inspect the current changes.',
      preparedExecution,
      processLabel: formatAgentProcessLabel('codex-cli', reservation.name),
    } satisfies AgentLaunchRequest;

    const launcher = new FakeAgentLauncher();
    const handle = await launcher.launch(reviewerLaunchRequest);

    expect(launcher.launches[0]?.request.preparedExecution.agentType).toBe('reviewer');
    expect(widenedPreparedExecution.agentType).toBe('implementer');
    await handle.release?.();
    reservation.release();
  });

  test('formats named labels without conflating names and provider identities', async () => {
    expect(formatAgentProcessLabel('claude-code', 'worker-one')).toBe('Claude agent (worker-one)');
    expect(formatAgentProcessLabel('codex-cli', 'worker-one')).toBe('Codex thread (worker-one)');

    const launcher = new FakeAgentLauncher();
    const manager = await createManager({ agentLauncher: launcher });
    const reservation = manager.reserveSubagent(reservationRequest('worker-one'));
    const input = new FakeAgentInputAdapter();
    input.markReady();
    input.setActiveAccepting();
    expect(
      input.deliver({
        messageId: 'message-1',
        source: manager.orchestratorIdentity,
        content: 'hello',
      })
    ).toBe('steered');
    expect(input.receivedMessages[0]?.source.name).toBe('orchestrator');
    reservation.release();
  });
});
