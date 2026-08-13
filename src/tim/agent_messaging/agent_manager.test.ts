import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { CleanupRegistry } from '../../common/cleanup_registry.js';
import {
  MAX_AGENT_MESSAGE_BYTES,
  MAX_AGENT_NAME_LENGTH,
  MAX_PENDING_MESSAGES_PER_RECIPIENT,
  MAX_SUBAGENTS_PER_SESSION,
  ORCHESTRATOR_AGENT_NAME,
  STOP_AGENT_INACTIVITY_TIMEOUT_MS,
} from './contracts.js';
import {
  AgentManagerError,
  AgentProviderControlError,
  createAgentManager,
  createAgentPreparation,
} from './index.js';
import {
  FakeAgentInputAdapter,
  FakeAgentLauncher,
  FakeAgentPreparer,
  FakeAgentManagerScheduler,
  FakeAgentProviderLifecycleControls,
} from './fake_provider.js';
import { formatAgentProcessLabel } from './agent_process_labels.js';
import { reserveSubagentForTest } from './agent_manager.test-support.js';
import { createAgentMessagingSessionRuntime } from './session_runtime.js';
import { getDefaultConfig } from '../configSchema.js';
import { writePlanFile } from '../plans.js';
import type {
  AgentLaunchRequest,
  AgentPreparationRequest,
  PreparedAgentExecution,
} from './agent_manager_types.js';
import type { AgentMailboxBinding } from './agent_mailbox_binding.js';
import type { AgentManager } from './agent_manager.js';
import {
  FORCE_STOP_STALE_CONTEXT_WARNING,
  NO_COMPLETED_ASSISTANT_MESSAGE,
} from './terminal_notifications.js';

const managers: Array<{ readonly manager: AgentManager; readonly launcher?: FakeAgentLauncher }> =
  [];

afterEach(async () => {
  await Promise.all(
    managers.splice(0).map(async ({ manager, launcher }) => {
      // Most manager tests do not exercise root teardown. Give those fake
      // providers a classified exit so the real teardown contract can wait
      // for terminal cleanup without leaving a live test provider behind.
      for (const launch of launcher?.launches ?? []) {
        if (manager.getAgentSnapshot(launch.request.identity.id) !== undefined) {
          launch.handle.lifecycle.emitExit('forced');
        }
      }
      await manager.close().catch(() => undefined);
    })
  );
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
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Condition did not become true');
}

async function flushLifecyclePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value: T): void => resolvePromise?.(value),
    reject: (error: unknown): void => rejectPromise?.(error),
  };
}

async function createManager(
  options: Parameters<typeof createAgentManager>[0] = {}
): Promise<AgentManager> {
  const manager = await createAgentManager({ agentIdGenerator: idGenerator(), ...options });
  managers.push({
    manager,
    launcher:
      options.agentLauncher instanceof FakeAgentLauncher ? options.agentLauncher : undefined,
  });
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

async function startActiveFakeAgent(
  manager: AgentManager,
  launcher: FakeAgentLauncher,
  name: string
): Promise<Awaited<ReturnType<FakeAgentLauncher['waitForNextLaunch']>>> {
  const launch = await startFakeAgent(manager, launcher, name);
  launch.handle.input.markReady();
  launch.handle.input.setActiveAccepting();
  await waitFor(
    () => manager.getAgentSnapshot(launch.request.identity.id)?.state === 'running-active'
  );
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
    const first = reserveSubagentForTest(manager, reservationRequest('zulu'));
    const second = reserveSubagentForTest(manager, reservationRequest('alpha', 'tester'));

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

  test('resolves the orchestrator from its stored root identity after map order changes', async () => {
    const manager = await createManager();
    reserveSubagentForTest(manager, reservationRequest('map-order-worker'));
    const internalDirectory = (manager as unknown as { readonly directory: object }).directory as {
      readonly byId: Map<string, unknown>;
      readonly orchestratorIdentity: { readonly id: string };
    };
    const rootEntry = [...internalDirectory.byId.entries()].find(
      ([id]) => id === manager.orchestratorIdentity.id
    );
    expect(rootEntry).toBeDefined();
    const nonRootEntries = [...internalDirectory.byId.entries()].filter(
      ([id]) => id !== manager.orchestratorIdentity.id
    );
    internalDirectory.byId.clear();
    for (const entry of nonRootEntries) {
      internalDirectory.byId.set(...entry);
    }
    internalDirectory.byId.set(...(rootEntry as [string, unknown]));

    expect(internalDirectory.orchestratorIdentity.id).toBe(manager.orchestratorIdentity.id);
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

      const closePromise = manager.close();
      preparation.reject(new Error('startup failed during root teardown'));
      await expect(startPromise).resolves.toMatchObject({ code: 'launch_failed' });
      await closePromise;
      expect(manager.listAgents().agents).toEqual([]);
      expect(manager.subagentCount).toBe(0);
      expect(await session.runtime.listRegistrations()).toEqual([]);
      expect(session.isClosed).toBe(false);

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
      const rootInput = new FakeAgentInputAdapter();
      rootInput.markReady();
      rootInput.setActiveAccepting();
      manager = await createManager({
        sessionRuntime: session,
        agentPreparer: createPreparer(),
        agentLauncher: launcher,
        orchestratorInputAdapter: rootInput,
      });
      const launchPromise = launcher.waitForNextLaunch();
      const startPromise = manager.startAgent(
        manager.orchestratorIdentity,
        reservationRequest('close-during-readiness')
      );
      const launch = await launchPromise;
      await waitFor(
        () => manager?.getAgentSnapshot(launch.request.identity.id)?.processControlId !== undefined
      );

      launch.handle.markReady();
      await expect(startPromise).resolves.toMatchObject({ name: 'close-during-readiness' });
      launch.handle.input.markReady();
      launch.handle.input.setActiveAccepting();
      const closePromise = manager.close();
      launch.handle.lifecycle.emitExit('graceful');
      await closePromise;
      expect(launch.handle.isReleased).toBe(true);
      expect(launch.handle.releaseCount).toBe(1);
      expect(manager.listAgents().agents).toEqual([]);
      expect(manager.subagentCount).toBe(0);
      expect(await session.runtime.listRegistrations()).toEqual([]);
      expect(session.isClosed).toBe(false);

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
    const startPromise = manager.startAgent(
      manager.orchestratorIdentity,
      reservationRequest('close-owned-runtime')
    );
    const launch = await launchPromise;

    await waitFor(
      () => manager.getAgentSnapshot(launch.request.identity.id)?.processControlId !== undefined
    );
    const closePromise = manager.close();
    launch.handle.markReady();
    launch.handle.lifecycle.emitExit('forced');
    await expect(startPromise).resolves.toMatchObject({
      name: 'close-owned-runtime',
      state: 'stopping',
    });
    await closePromise;
    expect(launch.handle.isReleased).toBe(true);
    expect(launch.handle.releaseCount).toBe(1);
    expect(manager.listAgents().agents).toEqual([]);
    expect(manager.subagentCount).toBe(0);
    expect(manager.sessionRuntime.isClosed).toBe(true);

    expect(manager.listAgents().agents).toEqual([]);
  });

  test('cleans up an owned runtime when root registration fails', async () => {
    const isolatedTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-manager-test-'));
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = isolatedTmp;

    try {
      await expect(
        createAgentManager({
          agentIdGenerator: () => 'r'.repeat(90),
          maxAgentIdGenerationAttempts: 1,
        })
      ).rejects.toMatchObject({
        name: 'AgentManagerError',
        code: 'root_registration_failed',
      });
      expect(await fs.readdir(isolatedTmp)).toEqual([]);
    } finally {
      if (originalTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpdir;
      }
      await fs.rm(isolatedTmp, { recursive: true });
    }
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

      launcher.launches[0]?.handle.lifecycle.emitExit('forced');
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

    const firstReservation = reserveSubagentForTest(first, reservationRequest('shared-name'));
    const secondReservation = reserveSubagentForTest(second, reservationRequest('shared-name'));

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
    const reservation = reserveSubagentForTest(manager, reservationRequest('immutable'));
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

  test('releases reservation-only test records through the explicit test support handle', async () => {
    const manager = await createManager();
    const reservation = reserveSubagentForTest(manager, reservationRequest('terminal-later'));
    manager.setAgentLifecycleState(reservation.id, 'finishing');
    expect(manager.listAgents().agents.map((agent) => agent.name)).toEqual([
      ORCHESTRATOR_AGENT_NAME,
      'terminal-later',
    ]);
    expect(manager.subagentCount).toBe(1);

    reservation.release();
    reservation.release();
    expect(manager.listAgents().agents.map((agent) => agent.name)).toEqual([
      ORCHESTRATOR_AGENT_NAME,
    ]);
    expect(manager.subagentCount).toBe(0);
    expect(manager.getIdentityByName('terminal-later')).toBeUndefined();
  });
});

describe('AgentManager names and atomic reservations', () => {
  test('accepts exact one- and 48-character names and rejects 49 characters', async () => {
    const manager = await createManager();
    const shortest = reserveSubagentForTest(manager, reservationRequest('a'));
    const longest = reserveSubagentForTest(
      manager,
      reservationRequest('b'.repeat(MAX_AGENT_NAME_LENGTH))
    );

    expect(shortest.name).toBe('a');
    expect(longest.name).toBe('b'.repeat(MAX_AGENT_NAME_LENGTH));
    expect(() =>
      reserveSubagentForTest(manager, reservationRequest('c'.repeat(MAX_AGENT_NAME_LENGTH + 1)))
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
      expect(() => reserveSubagentForTest(manager, reservationRequest(name))).toThrowError(
        AgentManagerError
      );
      expect(() => reserveSubagentForTest(manager, reservationRequest(name))).toThrowError(
        expect.objectContaining({ code: 'invalid_name' })
      );
    }

    expect(() =>
      reserveSubagentForTest(manager, reservationRequest(ORCHESTRATOR_AGENT_NAME))
    ).toThrowError(expect.objectContaining({ code: 'reserved_name' }));

    const original = reserveSubagentForTest(manager, reservationRequest('same-name'));
    expect(() => reserveSubagentForTest(manager, reservationRequest('same-name'))).toThrowError(
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
    const existing = reserveSubagentForTest(manager, reservationRequest('implementer-moss'));
    const generated = reserveSubagentForTest(manager, reservationRequest(undefined));
    expect(generated.name).toBe('implementer-river');
    existing.release();
    generated.release();

    const exhausted = await createManager({
      slugGenerator: (): string => 'same',
      maxAgentNameGenerationAttempts: 2,
    });
    const occupied = reserveSubagentForTest(exhausted, reservationRequest('tester-same'));
    expect(() =>
      reserveSubagentForTest(exhausted, reservationRequest(undefined, 'tester'))
    ).toThrowError(expect.objectContaining({ code: 'name_generation_exhausted' }));
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

    expect(() => reserveSubagentForTest(manager, reservationRequest(undefined))).toThrowError(
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

    const reservation = reserveSubagentForTest(manager, reservationRequest(undefined, 'tester'));
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
    const reservation = reserveSubagentForTest(manager, reservationRequest('valid-name'));
    expect(reservation.id).toBe('valid-agent-id');
    expect(index).toBe(generatedIds.length);
    reservation.release();

    const exhaustedIds = ['another-root', 'another-root', 'another-root', 'unused-agent'];
    let exhaustedIndex = 0;
    const exhausted = await createManager({
      agentIdGenerator: (): string => exhaustedIds[exhaustedIndex++] ?? 'unused',
      maxAgentIdGenerationAttempts: 2,
    });
    expect(() =>
      reserveSubagentForTest(exhausted, reservationRequest('not-allocated'))
    ).toThrowError(expect.objectContaining({ code: 'identity_generation_exhausted' }));
    expect(exhausted.subagentCount).toBe(0);
    const retry = reserveSubagentForTest(exhausted, reservationRequest('allocated-after-retry'));
    expect(retry.id).toBe('unused-agent');
    retry.release();
  });

  test('holds exactly eight nonterminal reservations and releases names and slots idempotently', async () => {
    const manager = await createManager();
    const reservations = Array.from({ length: MAX_SUBAGENTS_PER_SESSION }, (_, index) =>
      reserveSubagentForTest(manager, reservationRequest(`worker-${index}`))
    );
    expect(manager.subagentCount).toBe(MAX_SUBAGENTS_PER_SESSION);
    expect(() => reserveSubagentForTest(manager, reservationRequest('ninth'))).toThrowError(
      expect.objectContaining({ code: 'agent_limit_reached' })
    );

    reservations[0]?.release();
    reservations[0]?.release();
    expect(manager.subagentCount).toBe(MAX_SUBAGENTS_PER_SESSION - 1);
    const replacement = reserveSubagentForTest(manager, reservationRequest('ninth'));
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
      reserveSubagentForTest(manager, reservationRequest(`existing-${index}`))
    );
    const results = await Promise.allSettled(
      Array.from({ length: 32 }, (_, index) => `last-${index}`).map(async (name) =>
        reserveSubagentForTest(manager, reservationRequest(name))
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

  test('enforces the eight-agent limit through concurrent StartAgent calls', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: {
        launch: async (request: AgentLaunchRequest) => {
          const handle = await launcher.launch(request);
          handle.markReady();
          return handle;
        },
      },
    });
    const starts = Array.from({ length: MAX_SUBAGENTS_PER_SESSION + 1 }, (_, index) =>
      manager.startAgent(manager.orchestratorIdentity, reservationRequest(`public-worker-${index}`))
    );
    const settledStarts = Promise.allSettled(starts);

    const results = await settledStarts;
    expect(manager.subagentCount).toBe(MAX_SUBAGENTS_PER_SESSION);
    expect(launcher.launches).toHaveLength(MAX_SUBAGENTS_PER_SESSION);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
      MAX_SUBAGENTS_PER_SESSION
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'agent_limit_reached' });
    for (const launch of launcher.launches) launch.handle.lifecycle.emitExit('forced');
  });

  test('counts finishing and stopping reservations and preserves stable IDs across state changes', async () => {
    const manager = await createManager();
    const finishing = reserveSubagentForTest(manager, reservationRequest('finishing'));
    const stopping = reserveSubagentForTest(manager, reservationRequest('stopping'));
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

  test('rejects invalid and unknown lifecycle transition inputs', async () => {
    const manager = await createManager();
    const reservation = reserveSubagentForTest(manager, reservationRequest('lifecycle-worker'));

    expect(() => manager.setAgentLifecycleState('', 'finishing')).toThrowError(
      expect.objectContaining({ code: 'unknown_agent' })
    );
    expect(() => manager.setAgentLifecycleState('unknown-agent-id', 'finishing')).toThrowError(
      expect.objectContaining({ code: 'unknown_agent' })
    );
    expect(() => manager.setAgentLifecycleState(reservation.id, 'invalid' as never)).toThrowError(
      expect.objectContaining({ code: 'invalid_request' })
    );
    expect(manager.getAgentSnapshot(reservation.id)?.state).toBe('starting');
    reservation.release();
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
      const reservation = reserveSubagentForTest(manager, reservationRequest(`state-${index}`));
      manager.setAgentLifecycleState(reservation.id, state);
      return reservation;
    });

    expect(manager.subagentCount).toBe(MAX_SUBAGENTS_PER_SESSION);
    expect(manager.listAgents().agents.map((agent) => agent.state)).toEqual([
      'running-idle',
      ...states,
    ]);
    expect(() => reserveSubagentForTest(manager, reservationRequest('over-capacity'))).toThrowError(
      expect.objectContaining({ code: 'agent_limit_reached' })
    );
    for (const reservation of reservations) {
      reservation.release();
    }
    expect(manager.subagentCount).toBe(0);
  });

  test('does not consume capacity or replace the target on a custom-name collision', async () => {
    const manager = await createManager();
    const original = reserveSubagentForTest(manager, reservationRequest('collision-target'));

    expect(() =>
      reserveSubagentForTest(manager, reservationRequest('collision-target'))
    ).toThrowError(expect.objectContaining({ code: 'name_in_use' }));
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

  test('applies the same release validation to orchestrator and launched input adapters', async () => {
    const invalidReleaseInput = {
      ready: Promise.resolve(),
      isReady: true,
      activity: 'idle',
      deliver: (): 'started-idle-turn' => 'started-idle-turn',
      onAvailabilityChange: (): (() => void) => (): void => undefined,
      release: 'not-a-function',
    };

    await expect(
      createAgentManager({ orchestratorInputAdapter: invalidReleaseInput as never })
    ).rejects.toMatchObject({ code: 'invalid_options' });

    const launcher = {
      launch: async (request: AgentLaunchRequest) => ({
        executor: request.identity.executor,
        processLabel: request.processLabel,
        input: invalidReleaseInput,
        ready: Promise.resolve(),
        completion: new Promise<never>(() => undefined),
      }),
    };
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher as never,
    });

    await expect(
      manager.startAgent(manager.orchestratorIdentity, reservationRequest('invalid-release'))
    ).rejects.toMatchObject({ code: 'launch_failed' });
    expect(manager.subagentCount).toBe(0);
  });

  test('ignores extra untrusted caller fields and validates the request normally', async () => {
    const launcher = new FakeAgentLauncher();
    const preparer = createPreparer();
    const manager = await createManager({
      agentPreparer: preparer,
      agentLauncher: launcher,
    });

    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager.startAgent(
      {
        ...manager.orchestratorIdentity,
        name: 'forged-root',
        executor: 'claude-code',
      } as never,
      reservationRequest('validated-after-extra-fields')
    );
    const launch = await launchPromise;
    launch.handle.markReady();

    await expect(startPromise).resolves.toMatchObject({ name: 'validated-after-extra-fields' });
    expect(preparer.requests).toHaveLength(1);
  });

  test('rejects a stale caller ID before validating the StartAgent request', async () => {
    const launcher = new FakeAgentLauncher();
    const preparer = createPreparer();
    const manager = await createManager({ agentPreparer: preparer, agentLauncher: launcher });

    await expect(
      manager.startAgent(
        { id: 'stale-root', role: 'orchestrator' },
        {
          type: 'unsupported',
          executor: 'invalid',
          initialMessage: 42,
        }
      )
    ).rejects.toMatchObject({ code: 'not_authorized' });
    expect(manager.listAgents().agents).toHaveLength(1);
    expect(preparer.requests).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);
  });

  test('rejects a registered subagent caller before validating the StartAgent request', async () => {
    const launcher = new FakeAgentLauncher();
    const preparer = createPreparer();
    const manager = await createManager({ agentPreparer: preparer, agentLauncher: launcher });
    const subagent = reserveSubagentForTest(manager, reservationRequest('subagent-caller'));

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

  test('does not let an old reservation release a later reused name or slot', async () => {
    const manager = await createManager();
    const first = reserveSubagentForTest(manager, reservationRequest('reused-name'));
    const oldId = first.id;
    first.release();

    const second = reserveSubagentForTest(manager, reservationRequest('reused-name', 'reviewer'));
    expect(second.id).not.toBe(oldId);
    first.release();
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
      for (const launch of launcher.launches) launch.handle.lifecycle.emitExit('forced');
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

  test('derives caller fields from the stable bound identity and rejects source fields', async () => {
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
    ).resolves.toMatchObject({ name: 'spoof-target', delivery: 'started-idle-turn' });
    await expect(
      manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'spoof-target',
        message: 'must reject source field',
        source: 'spoofed-root',
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(target.handle.input.receivedMessages).toHaveLength(1);
    expect(target.handle.input.receivedMessages[0]?.source).toMatchObject({
      id: manager.orchestratorIdentity.id,
      name: ORCHESTRATOR_AGENT_NAME,
    });
  });

  test('reports an immediately vanished source as unknown_source at the mailbox boundary', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const source = await startFakeAgent(manager, launcher, 'vanished-source');
    const target = await startFakeAgent(manager, launcher, 'vanished-source-target');
    const sourceIdentity = {
      id: source.request.identity.id,
      name: source.request.identity.name,
    };

    source.handle.lifecycle.emitExit('natural');
    await manager.waitForAgentTerminal(source.request.identity.id);
    await expect(
      manager.sessionRuntime.sendMessage(
        sourceIdentity,
        { id: target.request.identity.id, name: target.request.identity.name },
        { requestId: 'vanished-source-request', content: 'must not deliver' }
      )
    ).rejects.toMatchObject({ code: 'unknown_source' });
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

  test('does not re-enter the drain when delivery synchronously notifies availability', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const target = await startFakeAgent(manager, launcher, 'synchronous-notification-target');
    target.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(target.request.identity.id)?.state === 'running-idle'
    );
    target.handle.input.setTemporarilyUnavailable();
    for (const message of ['first', 'second', 'third']) {
      await manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'synchronous-notification-target',
        message,
      });
    }

    const deliveryStarted = target.handle.input.deferNextDelivery();
    target.handle.input.notifyAvailabilityChangeInsideNextDelivery();
    target.handle.input.setActiveAccepting();
    await deliveryStarted;

    expect(target.handle.input.deliveryCalls).toBe(1);
    target.handle.input.resolveNextDelivery('steered');
    await waitFor(() => target.handle.input.receivedMessages.length === 3);
    expect(target.handle.input.receivedMessages.map((message) => message.content)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  test('requeues one rejected provider delivery and retries it once without losing FIFO work', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const target = await startFakeAgent(manager, launcher, 'rejected-delivery-target');
    target.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(target.request.identity.id)?.state === 'running-idle'
    );
    target.handle.input.setTemporarilyUnavailable();
    const queued = await Promise.all(
      ['retry me', 'second message', 'third message'].map((message) =>
        manager.sendAgentMessage(manager.orchestratorIdentity, {
          name: 'rejected-delivery-target',
          message,
        })
      )
    );
    expect(queued.map((result) => result.delivery)).toEqual(['queued', 'queued', 'queued']);

    target.handle.input.rejectNextDelivery();
    target.handle.input.setActiveAccepting();
    await waitFor(() => target.handle.input.receivedMessages.length === queued.length);

    expect(target.handle.input.deliveryCalls).toBe(queued.length + 1);
    expect(target.handle.input.receivedMessages.map((message) => message.content)).toEqual([
      'retry me',
      'second message',
      'third message',
    ]);
  });

  test('bounds retries when a ready provider persistently reports temporary refusal', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const target = await startFakeAgent(manager, launcher, 'persistent-temporary-target');
    target.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(target.request.identity.id)?.state === 'running-idle'
    );
    target.handle.input.setTemporarilyUnavailable();
    const queued = await Promise.all(
      ['first', 'second', 'third'].map((message) =>
        manager.sendAgentMessage(manager.orchestratorIdentity, {
          name: 'persistent-temporary-target',
          message,
        })
      )
    );
    expect(queued.map((result) => result.delivery)).toEqual(['queued', 'queued', 'queued']);

    target.handle.input.setPersistentTemporarilyUnavailable();
    target.handle.input.setActiveAccepting();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsAfterRetry = target.handle.input.deliveryCalls;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(target.handle.input.deliveryCalls).toBe(callsAfterRetry);
    expect(callsAfterRetry).toBe(2);
    expect(target.handle.input.receivedMessages).toHaveLength(0);

    target.handle.input.clearPersistentDeliveryRefusal();
    target.handle.input.setIdle();
    await waitFor(() => target.handle.input.receivedMessages.length === queued.length);
    expect(target.handle.input.receivedMessages.map((message) => message.content)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  test('bounds retries when a ready provider persistently rejects delivery', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const target = await startFakeAgent(manager, launcher, 'persistent-rejection-target');
    target.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(target.request.identity.id)?.state === 'running-idle'
    );
    target.handle.input.setTemporarilyUnavailable();
    const queued = await Promise.all(
      ['first', 'second', 'third'].map((message) =>
        manager.sendAgentMessage(manager.orchestratorIdentity, {
          name: 'persistent-rejection-target',
          message,
        })
      )
    );
    expect(queued.map((result) => result.delivery)).toEqual(['queued', 'queued', 'queued']);

    target.handle.input.setPersistentDeliveryRejection();
    target.handle.input.setActiveAccepting();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsAfterRetry = target.handle.input.deliveryCalls;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(target.handle.input.deliveryCalls).toBe(callsAfterRetry);
    expect(callsAfterRetry).toBe(2);
    expect(target.handle.input.receivedMessages).toHaveLength(0);

    target.handle.input.clearPersistentDeliveryRefusal();
    target.handle.input.setIdle();
    await waitFor(() => target.handle.input.receivedMessages.length === queued.length);
    expect(target.handle.input.receivedMessages.map((message) => message.content)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  test.each([
    { activity: 'active' as const, refusal: 'temporary' as const },
    { activity: 'active' as const, refusal: 'rejection' as const },
    { activity: 'idle' as const, refusal: 'temporary' as const },
    { activity: 'idle' as const, refusal: 'rejection' as const },
  ])(
    'does not spin for a persistent $activity provider $refusal on one availability version',
    async ({ activity, refusal }) => {
      const launcher = new FakeAgentLauncher();
      const manager = await createManager({
        agentPreparer: createPreparer(),
        agentLauncher: launcher,
      });
      const name = `persistent-${activity}-${refusal}`;
      const target = await startFakeAgent(manager, launcher, name);
      target.handle.input.markReady();
      await waitFor(
        () => manager.getAgentSnapshot(target.request.identity.id)?.state === 'running-idle'
      );
      target.handle.input.setTemporarilyUnavailable();
      const queued = await manager.sendAgentMessage(manager.orchestratorIdentity, {
        name,
        message: 'persistent refusal',
      });
      expect(queued.delivery).toBe('queued');

      if (refusal === 'temporary') {
        target.handle.input.setPersistentTemporarilyUnavailable();
      } else {
        target.handle.input.setPersistentDeliveryRejection();
      }
      if (activity === 'active') {
        target.handle.input.setActiveAccepting();
      } else {
        target.handle.input.setIdle();
      }

      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const callsAfterRetry = target.handle.input.deliveryCalls;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(target.handle.input.deliveryCalls).toBe(callsAfterRetry);
      expect(callsAfterRetry).toBe(2);
      expect(target.handle.input.receivedMessages).toHaveLength(0);
    }
  );

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

    sender.handle.lifecycle.emitExit('natural');
    await manager.waitForAgentTerminal(sender.request.identity.id);

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

  test('rechecks a mailbox fallback queued as a drain observes an empty lease', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const target = await startFakeAgent(manager, launcher, 'empty-lease-race-target');
    target.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(target.request.identity.id)?.state === 'running-idle'
    );
    target.handle.input.setTemporarilyUnavailable();
    await expect(
      manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'empty-lease-race-target',
        message: 'first',
      })
    ).resolves.toMatchObject({ delivery: 'queued' });

    const firstDeliveryStarted = target.handle.input.deferNextDelivery();
    target.handle.input.setActiveAccepting();
    await firstDeliveryStarted;

    const bindings = (
      manager as unknown as {
        readonly mailboxBindings: Map<string, AgentMailboxBinding>;
      }
    ).mailboxBindings;
    const binding = bindings.get(target.request.identity.id);
    if (binding === undefined) {
      throw new Error('Target mailbox binding was not found');
    }
    const originalDeliver = binding.deliver.bind(binding);
    const fallbackStarted = deferred<void>();
    const fallbackResult = deferred<'temporarily-unavailable'>();
    vi.spyOn(binding, 'deliver').mockImplementation((message, sourceRegistration) => {
      const result = originalDeliver(message, sourceRegistration);
      return result.then((delivery) => {
        expect(delivery).toBe('temporarily-unavailable');
        fallbackStarted.resolve(undefined);
        return fallbackResult.promise;
      });
    });

    const secondSend = manager.sendAgentMessage(manager.orchestratorIdentity, {
      name: 'empty-lease-race-target',
      message: 'second',
    });
    await fallbackStarted.promise;
    target.handle.input.resolveNextDelivery('steered');
    fallbackResult.resolve('temporarily-unavailable');

    await expect(secondSend).resolves.toMatchObject({ delivery: 'queued' });
    await waitFor(() => target.handle.input.receivedMessages.length === 2);
    expect(target.handle.input.receivedMessages.map((message) => message.content)).toEqual([
      'first',
      'second',
    ]);
  });

  test('retries a real mailbox fallback after a successful retry without another availability notification', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const target = await startFakeAgent(manager, launcher, 'retry-gate-boundary-target');
    target.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(target.request.identity.id)?.state === 'running-idle'
    );
    target.handle.input.setTemporarilyUnavailable();
    await expect(
      manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'retry-gate-boundary-target',
        message: 'first',
      })
    ).resolves.toMatchObject({ delivery: 'queued' });

    target.handle.input.rejectNextDelivery();
    const successfulRetryStarted = target.handle.input.deferNextDelivery();
    target.handle.input.setActiveAccepting();
    await successfulRetryStarted;
    expect(target.handle.input.deliveryCalls).toBe(2);
    const acceptedPause = target.handle.input.pauseAfterNextAcceptedDelivery();

    target.handle.input.resolveNextDelivery('steered');
    await acceptedPause.accepted;
    target.handle.input.rejectNextDelivery();
    const secondSend = manager.sendAgentMessage(manager.orchestratorIdentity, {
      name: 'retry-gate-boundary-target',
      message: 'second',
    });
    await expect(secondSend).resolves.toMatchObject({ delivery: 'queued' });
    acceptedPause.release();
    await waitFor(() => target.handle.input.receivedMessages.length === 2);
    expect(target.handle.input.deliveryCalls).toBe(4);
    expect(target.handle.input.receivedMessages.map((message) => message.content)).toEqual([
      'first',
      'second',
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
    stopping.handle.lifecycle.emitExit('natural');
    await manager.waitForAgentTerminal(stopping.request.identity.id);
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
  test('forwards non-reviewer preparation through the real subagent preparation service', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-agent-preparation-test-'));
    const repoRoot = path.join(tempDirectory, 'repository');
    const configDirectory = path.join(repoRoot, '.tim', 'config');
    const plansDirectory = path.join(repoRoot, '.tim', 'plans');
    const planId = 915;
    const configPath = path.join(configDirectory, 'tim.yml');
    const planPath = path.join(plansDirectory, `${planId}-preparation-test.plan.md`);
    const initialMessage = 'Prepare the second task with the requested provider settings.';

    try {
      await fs.mkdir(repoRoot, { recursive: true });
      await Bun.$`git init`.cwd(repoRoot).quiet();
      await Bun.$`git remote add origin ${`https://example.com/${path.basename(tempDirectory)}.git`}`
        .cwd(repoRoot)
        .quiet();
      await fs.mkdir(configDirectory, { recursive: true });
      await fs.mkdir(plansDirectory, { recursive: true });
      await fs.writeFile(configPath, 'defaultExecutor: claude-code\n', 'utf8');
      await writePlanFile(
        planPath,
        {
          id: planId,
          title: 'Preparation forwarding plan',
          goal: 'Verify preparation forwarding',
          details: 'A real plan fixture for AgentManager preparation.',
          status: 'pending',
          tasks: [
            { title: 'Ignore the first task', description: 'This task must be out of scope.' },
            { title: 'Prepare the second task', description: 'This task must be in scope.' },
          ],
        },
        { cwdForIdentity: repoRoot }
      );

      const manager = await createManager();
      const reservation = reserveSubagentForTest(
        manager,
        reservationRequest('real-prepared-agent', 'implementer')
      );
      try {
        const preparation = createAgentPreparation({
          planId,
          model: 'gpt-5-codex',
          taskIndex: '2',
          configPath,
          repositoryRoot: repoRoot,
        });

        const prepared = await preparation.prepare({
          identity: reservation.identity,
          initialMessage,
        });

        expect(prepared).toMatchObject({
          agentType: 'implementer',
          executor: 'codex-cli',
          model: 'gpt-5-codex',
          planId,
          gitRoot: repoRoot,
          planPath,
        });
        expect(prepared.plan.id).toBe(planId);
        expect(prepared.config.resolvedConfigPath).toBe(configPath);
        expect(prepared.prompt).toContain('Task 2: Prepare the second task');
        expect(prepared.prompt).toContain('This task must be in scope.');
        expect(prepared.prompt).toContain(initialMessage);
        expect(prepared.prompt).not.toContain('Task 1: Ignore the first task');
      } finally {
        reservation.release();
      }
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test('keeps collaborative reviewer preparation behind a narrow injected seam', async () => {
    const manager = await createManager();
    const reservation = reserveSubagentForTest(
      manager,
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

  test('rejects reviewer preparation when no collaborative preparer is configured', async () => {
    const manager = await createManager();
    const reservation = reserveSubagentForTest(
      manager,
      reservationRequest('reviewer-without-preparer', 'reviewer')
    );

    try {
      const preparation = createAgentPreparation({ planId: 1 });

      await expect(
        preparation.prepare({
          identity: reservation.identity,
          initialMessage: 'Review the current changes.',
        })
      ).rejects.toThrow('Collaborative reviewer preparation is not configured');
    } finally {
      reservation.release();
    }
  });

  test('formats named labels without conflating names and provider identities', () => {
    expect(formatAgentProcessLabel('claude-code', 'worker-one')).toBe('Claude agent (worker-one)');
    expect(formatAgentProcessLabel('codex-cli', 'worker-one')).toBe('Codex thread (worker-one)');
  });
});

describe('provider-neutral lifecycle controls and result tracking', () => {
  test('supports deferred controls, typed failures, and classified events', async () => {
    const lifecycle = new FakeAgentProviderLifecycleControls('opaque-agent-id' as never);
    const outputEvents = [];
    const completedEvents = [];
    const turnEvents = [];
    const exitEvents = [];
    lifecycle.onOutputActivity((event) => outputEvents.push(event));
    lifecycle.onCompletedAssistantMessage((event) => completedEvents.push(event));
    lifecycle.onTurnComplete((event) => turnEvents.push(event));
    lifecycle.onExit((event) => exitEvents.push(event));

    const gracefulStarted = lifecycle.deferNextGracefulShutdown();
    const gracefulRequest = lifecycle.requestGracefulShutdown('final status instruction');
    await gracefulStarted;
    expect(lifecycle.gracefulShutdownCalls).toBe(1);
    expect(lifecycle.gracefulShutdownInstructions).toEqual(['final status instruction']);
    lifecycle.resolveGracefulShutdown();
    await expect(gracefulRequest).resolves.toEqual({ accepted: true, alreadyExited: false });

    const closeStarted = lifecycle.deferNextCloseAfterCurrentTurn();
    const closeRequest = lifecycle.requestCloseAfterCurrentTurn();
    await closeStarted;
    lifecycle.resolveCloseAfterCurrentTurn();
    await expect(closeRequest).resolves.toEqual({ accepted: true, alreadyExited: false });

    const forcedError = new AgentProviderControlError('forced-shutdown', 'force was not accepted');
    lifecycle.failNextForcedShutdown(forcedError);
    await expect(lifecycle.requestForcedShutdown()).rejects.toBe(forcedError);
    expect(forcedError).toMatchObject({
      operation: 'forced-shutdown',
      accepted: false,
    });
    expect(lifecycle.forcedShutdownCalls).toBe(1);

    lifecycle.emitOutputActivity();
    lifecycle.emitCompletedAssistantMessage('  completed result  ');
    lifecycle.emitTurnComplete();
    lifecycle.emitExit('failed', new Error('provider failure'));
    expect(outputEvents).toHaveLength(1);
    expect(completedEvents[0]).toMatchObject({
      agentId: 'opaque-agent-id',
      message: '  completed result  ',
    });
    expect(turnEvents).toHaveLength(1);
    expect(exitEvents[0]).toMatchObject({
      agentId: 'opaque-agent-id',
      classification: 'failed',
    });
    await expect(lifecycle.requestForcedShutdown()).resolves.toEqual({
      accepted: false,
      alreadyExited: true,
    });
    await expect(lifecycle.requestGracefulShutdown('late shutdown')).resolves.toEqual({
      accepted: false,
      alreadyExited: true,
    });
    await expect(lifecycle.requestCloseAfterCurrentTurn()).resolves.toEqual({
      accepted: false,
      alreadyExited: true,
    });
  });

  test('binds events to the launched opaque identity and ignores late callbacks', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startFakeAgent(manager, launcher, 'lifecycle-target');
    const lifecycle = launch.handle.lifecycle;

    lifecycle.emitOutputActivity();
    lifecycle.emitCompletedAssistantMessage('  exact\tcompleted\nmessage  ');
    lifecycle.emitTurnComplete();
    lifecycle.emitOutputActivity();
    lifecycle.emitExit('natural');
    lifecycle.emitExit('failed', new Error('late failure'));
    lifecycle.emitOutputActivity('different-agent-id' as never);
    lifecycle.emitCompletedAssistantMessage('wrong identity', 'different-agent-id' as never);
    lifecycle.emitTurnComplete('different-agent-id' as never);

    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      providerOutputActivityCount: 2,
      providerTurnCompletionCount: 1,
      lastCompletedAssistantMessage: '  exact\tcompleted\nmessage  ',
      providerExit: { classification: 'natural' },
    });

    await manager.waitForAgentTerminal(launch.request.identity.id);
    lifecycle.emitOutputActivity();
    lifecycle.emitCompletedAssistantMessage('late completed message');
    lifecycle.emitTurnComplete();
    lifecycle.emitExit('forced');
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toBeUndefined();
  });

  test('does not let late events from a removed provider update a reused name', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const first = await startFakeAgent(manager, launcher, 'reused-lifecycle-name');
    const firstLifecycle = first.handle.lifecycle;
    const firstId = first.request.identity.id;

    firstLifecycle.emitOutputActivity();
    firstLifecycle.emitExit('natural');
    await manager.waitForAgentTerminal(firstId);

    const second = await startFakeAgent(manager, launcher, 'reused-lifecycle-name');
    second.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(second.request.identity.id)?.state === 'running-idle'
    );

    firstLifecycle.emitOutputActivity();
    firstLifecycle.emitCompletedAssistantMessage('stale result from the first provider');
    firstLifecycle.emitTurnComplete();
    firstLifecycle.emitExit('failed', new Error('stale provider failure'));

    expect(manager.getAgentSnapshot(second.request.identity.id)).toMatchObject({
      providerOutputActivityCount: 0,
      providerTurnCompletionCount: 0,
    });
    expect(manager.getAgentSnapshot(second.request.identity.id)).not.toHaveProperty(
      'lastCompletedAssistantMessage'
    );
    expect(manager.getAgentSnapshot(second.request.identity.id)).not.toHaveProperty('providerExit');
  });

  test('detaches lifecycle listeners when the manager closes', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startFakeAgent(manager, launcher, 'close-lifecycle-listeners');
    const lifecycle = launch.handle.lifecycle;

    lifecycle.emitOutputActivity();
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      providerOutputActivityCount: 1,
    });

    launch.handle.lifecycle.emitExit('forced');
    await manager.close();

    lifecycle.emitOutputActivity();
    lifecycle.emitCompletedAssistantMessage('late result after manager close');
    lifecycle.emitTurnComplete();
    lifecycle.emitExit('forced');

    expect(manager.isClosed).toBe(true);
    expect(manager.listAgents().agents).toEqual([]);
  });

  test('records successful outbound delivery only after acknowledgement', async () => {
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      orchestratorInputAdapter: rootInput,
    });
    const first = await startFakeAgent(manager, launcher, 'outbound-first');
    const second = await startFakeAgent(manager, launcher, 'outbound-second');
    first.handle.input.markReady();
    second.handle.input.markReady();
    await waitFor(
      () => manager.getAgentSnapshot(first.request.identity.id)?.state === 'running-idle'
    );
    await waitFor(
      () => manager.getAgentSnapshot(second.request.identity.id)?.state === 'running-idle'
    );

    const pause = first.handle.input.pauseAfterNextAcceptedDelivery();
    const pendingRootSend = manager.sendAgentMessage(manager.orchestratorIdentity, {
      name: 'outbound-first',
      message: '  first successful\tresult\n  ',
    });
    await pause.accepted;
    expect(manager.getAgentSnapshot(manager.orchestratorIdentity.id)?.lastSuccessfulOutbound).toBe(
      undefined
    );
    pause.release();
    await expect(pendingRootSend).resolves.toMatchObject({ delivery: 'started-idle-turn' });
    expect(
      manager.getAgentSnapshot(manager.orchestratorIdentity.id)?.lastSuccessfulOutbound
    ).toMatchObject({
      sequence: 1,
      target: 'outbound-first',
      content: '  first successful\tresult\n  ',
    });

    const firstIdentity = manager.getIdentityByName('outbound-first');
    await expect(
      manager.sendAgentMessage(firstIdentity as never, {
        name: 'outbound-second',
        message: 'peer result',
      })
    ).resolves.toMatchObject({ delivery: 'started-idle-turn' });
    expect(
      manager.getAgentSnapshot(first.request.identity.id)?.lastSuccessfulOutbound
    ).toMatchObject({
      sequence: 2,
      target: 'outbound-second',
      content: 'peer result',
    });

    const failedDelivery = new Error('provider rejected the outbound message');
    second.handle.input.rejectNextDelivery(failedDelivery);
    await expect(
      manager.sendAgentMessage(firstIdentity as never, {
        name: 'outbound-second',
        message: 'failed provider delivery must not replace snapshot',
      })
    ).rejects.toMatchObject({ code: 'transport_error' });
    expect(
      manager.getAgentSnapshot(first.request.identity.id)?.lastSuccessfulOutbound
    ).toMatchObject({
      sequence: 2,
      target: 'outbound-second',
      content: 'peer result',
    });

    await expect(
      manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'outbound-first',
        message: 'invalid source snapshot update',
        source: 'forged',
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(
      manager.getAgentSnapshot(manager.orchestratorIdentity.id)?.lastSuccessfulOutbound
    ).toMatchObject({
      sequence: 1,
      target: 'outbound-first',
      content: '  first successful\tresult\n  ',
    });

    await manager.sessionRuntime.deregister(second.request.identity.id);
    await expect(
      manager.sendAgentMessage(firstIdentity as never, {
        name: 'outbound-second',
        message: 'failed transport must not replace snapshot',
      })
    ).rejects.toMatchObject({ code: 'unknown_target' });
    expect(
      manager.getAgentSnapshot(first.request.identity.id)?.lastSuccessfulOutbound
    ).toMatchObject({
      sequence: 2,
      target: 'outbound-second',
      content: 'peer result',
    });
  });
});

describe('AgentManager FinishAgent lifecycle', () => {
  test('is self-only, target-free, and available only during an active turn', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const startingReservation = reserveSubagentForTest(
      manager,
      reservationRequest('finish-starting')
    );
    await expect(manager.finishAgent(startingReservation.identity, {})).rejects.toMatchObject({
      code: 'finish_not_available',
    });
    startingReservation.release();

    const idle = await startFakeAgent(manager, launcher, 'finish-idle');

    await expect(manager.finishAgent(idle.request.identity, {})).rejects.toMatchObject({
      code: 'finish_not_available',
    });
    await expect(
      manager.finishAgent(idle.request.identity, { target: 'finish-idle' })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      manager.finishAgent(manager.orchestratorIdentity, { message: 'root cannot finish' })
    ).rejects.toMatchObject({ code: 'not_authorized' });
    await expect(
      manager.finishAgent({ id: idle.request.identity.id, role: 'orchestrator' }, {})
    ).rejects.toMatchObject({ code: 'unknown_sender' });

    const active = await startActiveFakeAgent(manager, launcher, 'finish-active');
    const resultPromise = manager.finishAgent(active.request.identity, {});

    expect(manager.listAgents().agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'finish-active', state: 'finishing' }),
      ])
    );
    await expect(resultPromise).resolves.toEqual({ state: 'finishing' });
    expect(manager.listAgents().agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'finish-active', state: 'finishing' }),
      ])
    );
    expect(manager.subagentCount).toBe(2);
    await expect(
      manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'finish-active',
        message: 'new work',
      })
    ).rejects.toMatchObject({ code: 'target_not_accepting_messages' });
    expect(active.handle.lifecycle.closeAfterCurrentTurnCalls).toBe(0);
  });

  test('rejects stale and role-mismatched callers, including after name reuse', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const first = await startActiveFakeAgent(manager, launcher, 'finish-stale');
    const staleIdentity = first.request.identity;

    first.handle.lifecycle.emitExit('natural');
    await manager.waitForAgentTerminal(first.request.identity.id);
    await expect(manager.finishAgent(staleIdentity, {})).rejects.toMatchObject({
      code: 'unknown_sender',
    });

    const second = await startActiveFakeAgent(manager, launcher, 'finish-stale');
    await expect(
      manager.finishAgent({ id: second.request.identity.id, role: 'orchestrator' }, {})
    ).rejects.toMatchObject({ code: 'unknown_sender' });
    await expect(manager.finishAgent(second.request.identity, {})).resolves.toEqual({
      state: 'finishing',
    });
  });

  test('preserves the first nonblank fallback and closes only after turn completion', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'finish-order');
    const lifecycle = launch.handle.lifecycle;

    const closeStarted = lifecycle.deferNextCloseAfterCurrentTurn();
    await expect(
      manager.finishAgent(launch.request.identity, { message: '  fallback status  ' })
    ).resolves.toEqual({ state: 'finishing' });
    expect(lifecycle.closeAfterCurrentTurnCalls).toBe(0);
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      state: 'finishing',
      finishFallbackMessage: '  fallback status  ',
    });

    await expect(
      manager.finishAgent(launch.request.identity, { message: 'replacement status' })
    ).resolves.toEqual({ state: 'finishing' });
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      finishFallbackMessage: '  fallback status  ',
    });

    lifecycle.emitCompletedAssistantMessage('  completed\tassistant\nresult  ');
    expect(lifecycle.closeAfterCurrentTurnCalls).toBe(0);
    lifecycle.emitTurnComplete();
    await closeStarted;
    expect(lifecycle.closeAfterCurrentTurnCalls).toBe(1);
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      state: 'finishing',
      lastCompletedAssistantMessage: '  completed\tassistant\nresult  ',
      finishCloseAfterTurnRequested: true,
    });

    lifecycle.emitTurnComplete();
    expect(lifecycle.closeAfterCurrentTurnCalls).toBe(1);
    lifecycle.emitExit('natural');
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      providerExit: { classification: 'natural' },
    });
  });

  test('uses fallback state only when no completed assistant result exists', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'finish-fallback');
    const lifecycle = launch.handle.lifecycle;

    await manager.finishAgent(launch.request.identity, { message: 'final fallback' });
    lifecycle.emitTurnComplete();
    lifecycle.emitExit('natural');

    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      state: 'finishing',
      finishFallbackMessage: 'final fallback',
    });
    expect(manager.getAgentSnapshot(launch.request.identity.id)).not.toHaveProperty(
      'lastCompletedAssistantMessage'
    );
    await expect(
      manager.finishAgent(launch.request.identity, { message: 'late fallback' })
    ).rejects.toMatchObject({
      code: 'finish_not_available',
    });
  });

  test('ignores turn-complete and result callbacks after provider exit', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'finish-race');
    const lifecycle = launch.handle.lifecycle;

    await manager.finishAgent(launch.request.identity, { message: 'fallback' });
    lifecycle.emitExit('natural');
    lifecycle.emitCompletedAssistantMessage('late completed result');
    lifecycle.emitTurnComplete();

    expect(lifecycle.closeAfterCurrentTurnCalls).toBe(0);
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      providerExit: { classification: 'natural' },
    });
    expect(manager.getAgentSnapshot(launch.request.identity.id)).not.toHaveProperty(
      'lastCompletedAssistantMessage'
    );
  });

  test('does not request close after a forced-stop upgrade changes the state', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'finish-force-upgrade');

    await manager.finishAgent(launch.request.identity, {});
    manager.setAgentLifecycleState(launch.request.identity.id, 'stopping');
    launch.handle.lifecycle.emitTurnComplete();

    expect(launch.handle.lifecycle.closeAfterCurrentTurnCalls).toBe(0);
  });

  test('handles a close-after-turn rejection without retrying or losing terminal state', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'finish-close-rejected');
    const lifecycle = launch.handle.lifecycle;
    lifecycle.failNextCloseAfterCurrentTurn(new Error('close was not accepted'));

    await manager.finishAgent(launch.request.identity, { message: 'fallback' });
    lifecycle.emitTurnComplete();
    await Promise.resolve();
    await Promise.resolve();
    lifecycle.emitTurnComplete();

    expect(lifecycle.closeAfterCurrentTurnCalls).toBe(1);
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      state: 'finishing',
      finishCloseAfterTurnRequested: true,
    });
    lifecycle.emitExit('natural');
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      providerExit: { classification: 'natural' },
    });
  });

  test('accepts an already-exited close result and waits for the exit event', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'finish-close-exited');
    const lifecycle = launch.handle.lifecycle;
    const closeStarted = lifecycle.deferNextCloseAfterCurrentTurn();

    await manager.finishAgent(launch.request.identity, {});
    lifecycle.emitTurnComplete();
    await closeStarted;
    lifecycle.resolveCloseAfterCurrentTurn({ accepted: false, alreadyExited: true });
    await Promise.resolve();

    expect(lifecycle.closeAfterCurrentTurnCalls).toBe(1);
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      state: 'finishing',
      finishCloseAfterTurnRequested: true,
    });
    expect(manager.getAgentSnapshot(launch.request.identity.id)).not.toHaveProperty('providerExit');

    lifecycle.emitExit('natural');
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      providerExit: { classification: 'natural' },
    });
  });

  test('handles provider exit synchronously inside close-after-turn without duplicate close', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'finish-close-race');
    const lifecycle = launch.handle.lifecycle;
    lifecycle.exitDuringNextCloseAfterCurrentTurn('natural');

    await manager.finishAgent(launch.request.identity, {});
    lifecycle.emitTurnComplete();
    await Promise.resolve();

    expect(lifecycle.closeAfterCurrentTurnCalls).toBe(1);
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      state: 'finishing',
      providerExit: { classification: 'natural' },
      finishCloseAfterTurnRequested: true,
    });
    lifecycle.emitTurnComplete();
    lifecycle.emitExit('failed', new Error('late failure'));
    expect(lifecycle.closeAfterCurrentTurnCalls).toBe(1);
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      providerExit: { classification: 'natural' },
    });
  });

  test('keeps the finishing seam visible until explicit terminal removal', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'finish-removal');
    const lifecycle = launch.handle.lifecycle;
    const staleIdentity = launch.request.identity;

    await manager.finishAgent(staleIdentity, { message: 'fallback' });
    lifecycle.emitTurnComplete();
    lifecycle.emitExit('natural');

    expect(manager.listAgents().agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'finish-removal', state: 'finishing' }),
      ])
    );
    await manager.waitForAgentTerminal(staleIdentity.id);
    expect(manager.listAgents().agents).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'finish-removal' })])
    );
    await expect(manager.finishAgent(staleIdentity, {})).rejects.toMatchObject({
      code: 'unknown_sender',
    });

    lifecycle.emitCompletedAssistantMessage('late result');
    lifecycle.emitTurnComplete();
    lifecycle.emitExit('failed', new Error('late failure'));
    expect(manager.listAgents().agents).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'finish-removal' })])
    );
  });

  test('accepts the first nonblank fallback after an empty first request', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'finish-blank-fallback');

    await manager.finishAgent(launch.request.identity, { message: '   ' });
    await manager.finishAgent(launch.request.identity, { message: 'useful fallback' });
    await manager.finishAgent(launch.request.identity, { message: 'replacement fallback' });

    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      finishFallbackMessage: 'useful fallback',
    });
  });
});

describe('AgentManager StopAgent lifecycle', () => {
  test('records a stop intent while startup is pending and controls the provider when ready', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager.startAgent(manager.orchestratorIdentity, {
      name: 'stop-during-startup',
      type: 'tester',
      executor: 'codex-cli',
      initialMessage: 'Start the provider.',
    });
    const launch = await launchPromise;
    const gracefulStarted = launch.handle.lifecycle.deferNextGracefulShutdown();

    await expect(
      manager.stopAgent(manager.orchestratorIdentity, { name: 'stop-during-startup' })
    ).resolves.toEqual({
      name: 'stop-during-startup',
      mode: 'graceful-requested',
      state: 'stopping',
    });
    expect(launch.handle.lifecycle.gracefulShutdownCalls).toBe(0);
    launch.handle.markReady();
    await expect(startPromise).resolves.toMatchObject({
      name: 'stop-during-startup',
      state: 'stopping',
    });
    expect(launch.handle.lifecycle.gracefulShutdownCalls).toBe(1);
    launch.handle.lifecycle.resolveGracefulShutdown();
    await gracefulStarted;
  });

  test('records a force intent while startup is pending and controls the provider when ready', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launchPromise = launcher.waitForNextLaunch();
    const startPromise = manager.startAgent(manager.orchestratorIdentity, {
      name: 'force-during-startup',
      type: 'tester',
      executor: 'codex-cli',
      initialMessage: 'Start the provider.',
    });
    const launch = await launchPromise;
    const forceStarted = launch.handle.lifecycle.deferNextForcedShutdown();

    await expect(
      manager.stopAgent(manager.orchestratorIdentity, {
        name: 'force-during-startup',
        force: true,
      })
    ).resolves.toEqual({
      name: 'force-during-startup',
      mode: 'forced',
      state: 'stopping',
    });
    expect(launch.handle.lifecycle.forcedShutdownCalls).toBe(0);

    launch.handle.markReady();
    await expect(startPromise).resolves.toMatchObject({
      name: 'force-during-startup',
      state: 'stopping',
    });
    await forceStarted;
    expect(launch.handle.lifecycle.forcedShutdownCalls).toBe(1);
    launch.handle.lifecycle.resolveForcedShutdown();
    await flushLifecyclePromises();
    expect(launch.handle.lifecycle.forcedShutdownCalls).toBe(1);
  });

  test('is orchestrator-only, protects the reserved target, and sends one graceful instruction', async () => {
    const launcher = new FakeAgentLauncher();
    const scheduler = new FakeAgentManagerScheduler();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      scheduler,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-authorized');
    const lifecycle = launch.handle.lifecycle;
    const gracefulStarted = lifecycle.deferNextGracefulShutdown();

    await expect(
      manager.stopAgent(launch.request.identity, { name: 'stop-authorized' })
    ).rejects.toMatchObject({ code: 'not_authorized' });
    await expect(
      manager.stopAgent(manager.orchestratorIdentity, { name: ORCHESTRATOR_AGENT_NAME })
    ).rejects.toMatchObject({ code: 'reserved_name' });

    const first = await manager.stopAgent(manager.orchestratorIdentity, {
      name: 'stop-authorized',
      message: 'Report the changed files before exit.',
    });
    expect(first).toEqual({
      name: 'stop-authorized',
      mode: 'graceful-requested',
      state: 'stopping',
    });
    expect(manager.listAgents().agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'stop-authorized', state: 'stopping' }),
      ])
    );
    expect(lifecycle.gracefulShutdownCalls).toBe(1);
    expect(lifecycle.gracefulShutdownInstructions[0]).toContain(
      'provide your final status update or result'
    );
    expect(lifecycle.gracefulShutdownInstructions[0]).toContain(
      'Additional shutdown context:\n---\nReport the changed files before exit.\n---'
    );

    await expect(
      manager.stopAgent(manager.orchestratorIdentity, {
        name: 'stop-authorized',
        message: 'A second instruction must not be sent.',
      })
    ).resolves.toEqual({ name: 'stop-authorized', mode: 'already-stopping', state: 'stopping' });
    expect(lifecycle.gracefulShutdownCalls).toBe(1);
    expect(scheduler.pendingTimerCount).toBe(0);

    lifecycle.resolveGracefulShutdown();
    await gracefulStarted;
    await flushLifecyclePromises();
    expect(scheduler.pendingTimerCount).toBe(1);
  });

  test('validates the target strictly before starting provider shutdown', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-target-validation');

    await expect(
      manager.stopAgent(launch.request.identity, { name: 'stop-target-validation' })
    ).rejects.toMatchObject({ code: 'not_authorized' });
    await expect(
      manager.stopAgent(manager.orchestratorIdentity, { name: '' })
    ).rejects.toMatchObject({ code: 'invalid_name' });
    await expect(
      manager.stopAgent(manager.orchestratorIdentity, { name: 'UpperCase' })
    ).rejects.toMatchObject({ code: 'invalid_name' });
    await expect(
      manager.stopAgent(manager.orchestratorIdentity, { name: 'not/a-name' })
    ).rejects.toMatchObject({ code: 'invalid_name' });
    await expect(
      manager.stopAgent(manager.orchestratorIdentity, { name: 'missing-target' })
    ).rejects.toMatchObject({ code: 'unknown_target' });

    expect(launch.handle.lifecycle.gracefulShutdownCalls).toBe(0);
  });

  test('keeps the standard instruction exact and does not shift a duplicate timer', async () => {
    const launcher = new FakeAgentLauncher();
    const scheduler = new FakeAgentManagerScheduler();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      scheduler,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-instruction-boundary');
    const lifecycle = launch.handle.lifecycle;
    const gracefulStarted = lifecycle.deferNextGracefulShutdown();

    await expect(
      manager.stopAgent(manager.orchestratorIdentity, {
        name: 'stop-instruction-boundary',
        message: 'Keep this context separate from the required instruction.',
      })
    ).resolves.toEqual({
      name: 'stop-instruction-boundary',
      mode: 'graceful-requested',
      state: 'stopping',
    });
    expect(lifecycle.gracefulShutdownInstructions).toEqual([
      'The orchestrator has requested a graceful shutdown. Complete your current work, then provide your final status update or result before ending your session.\n\nAdditional shutdown context:\n---\nKeep this context separate from the required instruction.\n---',
    ]);
    await expect(
      manager.sendAgentMessage(manager.orchestratorIdentity, {
        name: 'stop-instruction-boundary',
        message: 'ordinary messages must be rejected immediately',
      })
    ).rejects.toMatchObject({ code: 'target_not_accepting_messages' });

    lifecycle.resolveGracefulShutdown();
    await gracefulStarted;
    await flushLifecyclePromises();
    expect(scheduler.pendingTimerCount).toBe(1);

    scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS - 1);
    await expect(
      manager.stopAgent(manager.orchestratorIdentity, {
        name: 'stop-instruction-boundary',
        message: 'This duplicate must not shift the deadline.',
      })
    ).resolves.toEqual({
      name: 'stop-instruction-boundary',
      mode: 'already-stopping',
      state: 'stopping',
    });
    expect(lifecycle.gracefulShutdownCalls).toBe(1);
    expect(scheduler.pendingTimerCount).toBe(1);

    scheduler.advanceBy(1);
    expect(lifecycle.forcedShutdownCalls).toBe(1);
  });

  test('uses output inactivity, resets only the affected agent, and honors the exact deadline', async () => {
    const launcher = new FakeAgentLauncher();
    const scheduler = new FakeAgentManagerScheduler();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      scheduler,
    });
    const first = await startActiveFakeAgent(manager, launcher, 'stop-chatty');
    const second = await startActiveFakeAgent(manager, launcher, 'stop-silent');

    await manager.stopAgent(manager.orchestratorIdentity, { name: 'stop-chatty' });
    await manager.stopAgent(manager.orchestratorIdentity, { name: 'stop-silent' });
    await flushLifecyclePromises();
    expect(scheduler.pendingTimerCount).toBe(2);

    scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS - 1);
    first.handle.lifecycle.emitOutputActivity();
    scheduler.advanceBy(1);
    expect(first.handle.lifecycle.forcedShutdownCalls).toBe(0);
    expect(second.handle.lifecycle.forcedShutdownCalls).toBe(1);

    scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS - 2);
    expect(first.handle.lifecycle.forcedShutdownCalls).toBe(0);
    scheduler.advanceBy(1);
    expect(first.handle.lifecycle.forcedShutdownCalls).toBe(1);
    expect(second.handle.lifecycle.forcedShutdownCalls).toBe(1);
  });

  test('ignores repeated stale timer callbacks after activity resets', async () => {
    const launcher = new FakeAgentLauncher();
    const scheduler = new FakeAgentManagerScheduler();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      scheduler,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-stale-timers');
    const lifecycle = launch.handle.lifecycle;

    await manager.stopAgent(manager.orchestratorIdentity, { name: 'stop-stale-timers' });
    await flushLifecyclePromises();
    scheduler.advanceBy(30_000);
    lifecycle.emitOutputActivity();
    scheduler.advanceBy(30_000);
    lifecycle.emitOutputActivity();
    expect(scheduler.pendingTimerCount).toBe(1);

    scheduler.runCancelledTimerCallbacks();
    expect(lifecycle.forcedShutdownCalls).toBe(0);
    expect(scheduler.pendingTimerCount).toBe(1);

    scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS - 1);
    expect(lifecycle.forcedShutdownCalls).toBe(0);
    scheduler.advanceBy(1);
    expect(lifecycle.forcedShutdownCalls).toBe(1);
  });

  test('arms from the latest activity after slow graceful acceptance', async () => {
    const launcher = new FakeAgentLauncher();
    const scheduler = new FakeAgentManagerScheduler();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      scheduler,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-slow-acceptance');
    const lifecycle = launch.handle.lifecycle;
    const gracefulStarted = lifecycle.deferNextGracefulShutdown();

    await manager.stopAgent(manager.orchestratorIdentity, { name: 'stop-slow-acceptance' });
    scheduler.advanceBy(10_000);
    lifecycle.emitOutputActivity();
    scheduler.advanceBy(110_000);
    expect(lifecycle.forcedShutdownCalls).toBe(0);

    lifecycle.resolveGracefulShutdown();
    await gracefulStarted;
    await flushLifecyclePromises();
    expect(scheduler.pendingTimerCount).toBe(1);
    scheduler.advanceBy(9_999);
    expect(lifecycle.forcedShutdownCalls).toBe(0);
    scheduler.advanceBy(1);
    expect(lifecycle.forcedShutdownCalls).toBe(1);
  });

  test('starts the grace window at acceptance when acceptance is slow without output', async () => {
    const launcher = new FakeAgentLauncher();
    const scheduler = new FakeAgentManagerScheduler();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      scheduler,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-acceptance-clock');
    const lifecycle = launch.handle.lifecycle;
    const gracefulStarted = lifecycle.deferNextGracefulShutdown();

    await manager.stopAgent(manager.orchestratorIdentity, { name: 'stop-acceptance-clock' });
    scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS);
    lifecycle.resolveGracefulShutdown();
    await gracefulStarted;
    await flushLifecyclePromises();
    expect(lifecycle.forcedShutdownCalls).toBe(0);
    scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS - 1);
    expect(lifecycle.forcedShutdownCalls).toBe(0);
    scheduler.advanceBy(1);
    expect(lifecycle.forcedShutdownCalls).toBe(1);
  });

  test('does not arm a timer when graceful control reports an already-exited provider', async () => {
    const launcher = new FakeAgentLauncher();
    const scheduler = new FakeAgentManagerScheduler();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      scheduler,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-graceful-exited');
    const lifecycle = launch.handle.lifecycle;
    const gracefulStarted = lifecycle.deferNextGracefulShutdown();

    await manager.stopAgent(manager.orchestratorIdentity, { name: 'stop-graceful-exited' });
    lifecycle.resolveGracefulShutdown({ accepted: false, alreadyExited: true });
    await gracefulStarted;
    await flushLifecyclePromises();

    expect(scheduler.pendingTimerCount).toBe(0);
    scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS * 2);
    expect(lifecycle.forcedShutdownCalls).toBe(0);
  });

  test('forces immediately, upgrades graceful stopping, and accepts force only once', async () => {
    const launcher = new FakeAgentLauncher();
    const scheduler = new FakeAgentManagerScheduler();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      scheduler,
    });
    const first = await startActiveFakeAgent(manager, launcher, 'stop-force-first');
    const forceStarted = first.handle.lifecycle.deferNextForcedShutdown();
    const forcePromise = manager.stopAgent(manager.orchestratorIdentity, {
      name: 'stop-force-first',
      force: true,
    });
    expect(manager.getAgentSnapshot(first.request.identity.id)).toMatchObject({
      state: 'stopping',
    });
    expect(first.handle.lifecycle.forcedShutdownCalls).toBe(1);
    const duplicateForce = manager.stopAgent(manager.orchestratorIdentity, {
      name: 'stop-force-first',
      force: true,
    });
    first.handle.lifecycle.resolveForcedShutdown();
    await forceStarted;
    await expect(forcePromise).resolves.toEqual({
      name: 'stop-force-first',
      mode: 'forced',
      state: 'stopping',
    });
    await expect(duplicateForce).resolves.toEqual({
      name: 'stop-force-first',
      mode: 'forced',
      state: 'stopping',
    });
    expect(first.handle.lifecycle.forcedShutdownCalls).toBe(1);
    expect(first.handle.lifecycle.gracefulShutdownCalls).toBe(0);

    const second = await startActiveFakeAgent(manager, launcher, 'stop-force-upgrade');
    await manager.stopAgent(manager.orchestratorIdentity, { name: 'stop-force-upgrade' });
    await flushLifecyclePromises();
    expect(scheduler.pendingTimerCount).toBe(1);
    const upgradeStarted = second.handle.lifecycle.deferNextForcedShutdown();
    const upgrade = manager.stopAgent(manager.orchestratorIdentity, {
      name: 'stop-force-upgrade',
      force: true,
    });
    expect(scheduler.pendingTimerCount).toBe(0);
    expect(second.handle.lifecycle.gracefulShutdownCalls).toBe(1);
    expect(second.handle.lifecycle.forcedShutdownCalls).toBe(1);
    second.handle.lifecycle.resolveForcedShutdown();
    await upgradeStarted;
    await expect(upgrade).resolves.toEqual({
      name: 'stop-force-upgrade',
      mode: 'forced',
      state: 'stopping',
    });
    await expect(
      manager.stopAgent(manager.orchestratorIdentity, { name: 'stop-force-upgrade', force: true })
    ).resolves.toEqual({ name: 'stop-force-upgrade', mode: 'forced', state: 'stopping' });
    expect(second.handle.lifecycle.forcedShutdownCalls).toBe(1);
  });

  test('does not arm graceful inactivity after a force upgrade during acceptance', async () => {
    const launcher = new FakeAgentLauncher();
    const scheduler = new FakeAgentManagerScheduler();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      scheduler,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-force-while-accepting');
    const lifecycle = launch.handle.lifecycle;
    const gracefulStarted = lifecycle.deferNextGracefulShutdown();

    await manager.stopAgent(manager.orchestratorIdentity, {
      name: 'stop-force-while-accepting',
    });
    const forceStarted = lifecycle.deferNextForcedShutdown();
    const force = manager.stopAgent(manager.orchestratorIdentity, {
      name: 'stop-force-while-accepting',
      force: true,
    });
    expect(scheduler.pendingTimerCount).toBe(0);
    expect(lifecycle.gracefulShutdownCalls).toBe(1);
    expect(lifecycle.forcedShutdownCalls).toBe(1);

    lifecycle.resolveGracefulShutdown();
    lifecycle.resolveForcedShutdown();
    await gracefulStarted;
    await forceStarted;
    await expect(force).resolves.toEqual({
      name: 'stop-force-while-accepting',
      mode: 'forced',
      state: 'stopping',
    });
    await flushLifecyclePromises();
    expect(scheduler.pendingTimerCount).toBe(0);
  });

  test('does not close a finishing turn when force upgrades it', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-finishing-upgrade');
    await manager.finishAgent(launch.request.identity, { message: 'fallback' });
    const force = manager.stopAgent(manager.orchestratorIdentity, {
      name: 'stop-finishing-upgrade',
      force: true,
    });
    launch.handle.lifecycle.emitTurnComplete();
    await expect(force).resolves.toMatchObject({ mode: 'forced', state: 'stopping' });
    expect(launch.handle.lifecycle.closeAfterCurrentTurnCalls).toBe(0);
    expect(launch.handle.lifecycle.forcedShutdownCalls).toBe(1);
  });

  test('allows a later explicit force retry after guaranteed unaccepted failure', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-force-retry');
    const failure = new AgentProviderControlError('forced-shutdown', 'force was not accepted');
    launch.handle.lifecycle.failNextForcedShutdown(failure);

    await expect(
      manager.stopAgent(manager.orchestratorIdentity, {
        name: 'stop-force-retry',
        force: true,
      })
    ).rejects.toMatchObject({
      code: 'force_failed',
      message: expect.stringContaining('not accepted'),
    });
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      state: 'stopping',
    });
    expect(launch.handle.lifecycle.forcedShutdownCalls).toBe(1);

    const retryStarted = launch.handle.lifecycle.deferNextForcedShutdown();
    const retry = manager.stopAgent(manager.orchestratorIdentity, {
      name: 'stop-force-retry',
      force: true,
    });
    launch.handle.lifecycle.resolveForcedShutdown();
    await retryStarted;
    await expect(retry).resolves.toEqual({
      name: 'stop-force-retry',
      mode: 'forced',
      state: 'stopping',
    });
    expect(launch.handle.lifecycle.forcedShutdownCalls).toBe(2);
  });

  test('retains an unknown force outcome without issuing an unsafe retry', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-force-unknown');
    launch.handle.lifecycle.failNextForcedShutdown(new Error('provider outcome is unknown'));

    await expect(
      manager.stopAgent(manager.orchestratorIdentity, {
        name: 'stop-force-unknown',
        force: true,
      })
    ).rejects.toMatchObject({
      code: 'force_failed',
      message: expect.stringContaining('status is unknown'),
    });
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      state: 'stopping',
    });

    await expect(
      manager.stopAgent(manager.orchestratorIdentity, {
        name: 'stop-force-unknown',
        force: true,
      })
    ).resolves.toEqual({ name: 'stop-force-unknown', mode: 'forced', state: 'stopping' });
    expect(launch.handle.lifecycle.forcedShutdownCalls).toBe(1);
  });

  test('clears inactivity timers when an agent exits or the manager closes', async () => {
    const launcher = new FakeAgentLauncher();
    const scheduler = new FakeAgentManagerScheduler();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      scheduler,
    });

    const exited = await startActiveFakeAgent(manager, launcher, 'stop-timer-exit');
    await manager.stopAgent(manager.orchestratorIdentity, { name: 'stop-timer-exit' });
    await flushLifecyclePromises();
    expect(scheduler.pendingTimerCount).toBe(1);
    exited.handle.lifecycle.emitExit('natural');
    expect(scheduler.pendingTimerCount).toBe(0);
    scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS * 2);
    expect(exited.handle.lifecycle.forcedShutdownCalls).toBe(0);

    const removed = await startActiveFakeAgent(manager, launcher, 'stop-timer-remove');
    await manager.stopAgent(manager.orchestratorIdentity, { name: 'stop-timer-remove' });
    await flushLifecyclePromises();
    expect(scheduler.pendingTimerCount).toBe(1);
    removed.handle.lifecycle.emitExit('natural');
    await manager.waitForAgentTerminal(removed.request.identity.id);
    expect(scheduler.pendingTimerCount).toBe(0);
    scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS * 2);
    expect(removed.handle.lifecycle.forcedShutdownCalls).toBe(0);

    const closed = await startActiveFakeAgent(manager, launcher, 'stop-timer-close');
    await manager.stopAgent(manager.orchestratorIdentity, { name: 'stop-timer-close' });
    await flushLifecyclePromises();
    expect(scheduler.pendingTimerCount).toBe(1);
    closed.handle.lifecycle.emitExit('natural');
    await manager.close();
    expect(scheduler.pendingTimerCount).toBe(0);
    scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS * 2);
    expect(closed.handle.lifecycle.forcedShutdownCalls).toBe(0);
  });

  test('automatic force failure is recorded without cleanup and remains explicitly retryable', async () => {
    const launcher = new FakeAgentLauncher();
    const scheduler = new FakeAgentManagerScheduler();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      scheduler,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-auto-retry');
    await manager.stopAgent(manager.orchestratorIdentity, { name: 'stop-auto-retry' });
    await flushLifecyclePromises();
    launch.handle.lifecycle.failNextForcedShutdown(
      new AgentProviderControlError('forced-shutdown', 'automatic force was not accepted')
    );
    scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS);
    await flushLifecyclePromises();
    expect(launch.handle.lifecycle.forcedShutdownCalls).toBe(1);
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      state: 'stopping',
    });

    const retryStarted = launch.handle.lifecycle.deferNextForcedShutdown();
    const retry = manager.stopAgent(manager.orchestratorIdentity, {
      name: 'stop-auto-retry',
      force: true,
    });
    launch.handle.lifecycle.resolveForcedShutdown();
    await retryStarted;
    await expect(retry).resolves.toMatchObject({ mode: 'forced', state: 'stopping' });
    expect(launch.handle.lifecycle.forcedShutdownCalls).toBe(2);
  });

  test('does not force a provider that already reported a natural exit', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-already-exited');
    launch.handle.lifecycle.emitExit('natural');

    await expect(
      manager.stopAgent(manager.orchestratorIdentity, {
        name: 'stop-already-exited',
        force: true,
      })
    ).resolves.toEqual({
      name: 'stop-already-exited',
      mode: 'already-stopping',
      state: 'running-active',
    });
    expect(launch.handle.lifecycle.forcedShutdownCalls).toBe(0);
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      providerExit: { classification: 'natural' },
      state: 'running-active',
    });
  });

  test('preserves an already-exited force result without inventing a forced exit', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-control-already-exited');
    const forceStarted = launch.handle.lifecycle.deferNextForcedShutdown();
    const force = manager.stopAgent(manager.orchestratorIdentity, {
      name: 'stop-control-already-exited',
      force: true,
    });
    launch.handle.lifecycle.resolveForcedShutdown({ accepted: false, alreadyExited: true });
    await forceStarted;

    await expect(force).resolves.toEqual({
      name: 'stop-control-already-exited',
      mode: 'forced',
      state: 'stopping',
    });
    expect(manager.getAgentSnapshot(launch.request.identity.id)).not.toHaveProperty('providerExit');
    expect(launch.handle.lifecycle.forcedShutdownCalls).toBe(1);
  });

  test('keeps the provider exit classification when force and exit race', async () => {
    const launcher = new FakeAgentLauncher();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'stop-exit-race');
    const forceStarted = launch.handle.lifecycle.deferNextForcedShutdown();
    const force = manager.stopAgent(manager.orchestratorIdentity, {
      name: 'stop-exit-race',
      force: true,
    });
    launch.handle.lifecycle.emitExit('natural');
    launch.handle.lifecycle.resolveForcedShutdown();
    await forceStarted;
    await expect(force).resolves.toMatchObject({ mode: 'forced' });
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toMatchObject({
      providerExit: { classification: 'natural' },
    });
  });
});

describe('AgentManager terminal convergence', () => {
  test('delivers one natural terminal notification and cleans resources after delivery', async () => {
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      orchestratorInputAdapter: rootInput,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'terminal-natural');
    launch.handle.lifecycle.emitCompletedAssistantMessage('final result');
    launch.handle.lifecycle.emitExit('natural');

    expect(manager.listAgents().agents).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'terminal-natural' })])
    );
    await manager.waitForAgentTerminal(launch.request.identity.id);

    expect(rootInput.receivedMessages).toHaveLength(1);
    expect(rootInput.receivedMessages[0]).toMatchObject({
      source: { id: launch.request.identity.id, name: 'terminal-natural' },
      content: expect.stringContaining('final result'),
    });
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toBeUndefined();
    expect(launch.handle.releaseCount).toBe(1);
    expect(manager.listAgents().agents).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'terminal-natural' })])
    );
  });

  test('keeps a terminal agent visible until its one notification attempt settles', async () => {
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      orchestratorInputAdapter: rootInput,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'terminal-delivery-barrier');
    const deliveryStarted = rootInput.deferNextDelivery();
    launch.handle.lifecycle.emitExit('natural');
    await deliveryStarted;

    expect(manager.listAgents().agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'terminal-delivery-barrier', state: 'running-active' }),
      ])
    );
    expect(launch.handle.releaseCount).toBe(0);

    rootInput.resolveNextDelivery('steered');
    await manager.waitForAgentTerminal(launch.request.identity.id);
    expect(manager.getAgentSnapshot(launch.request.identity.id)).toBeUndefined();
    expect(launch.handle.releaseCount).toBe(1);
  });

  test('suppresses only the exact approved duplicate and keeps cleanup single-shot', async () => {
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      orchestratorInputAdapter: rootInput,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'terminal-dedup');

    await manager.sendAgentMessage(manager.orchestratorIdentity, {
      name: 'terminal-dedup',
      message: 'Done.\n',
    });
    launch.handle.lifecycle.emitCompletedAssistantMessage('  Done.  ');
    launch.handle.lifecycle.emitExit('natural');
    launch.handle.lifecycle.emitExit('failed', new Error('late failure'));
    await manager.waitForAgentTerminal(launch.request.identity.id);

    expect(rootInput.receivedMessages).toHaveLength(1);
    expect(launch.handle.releaseCount).toBe(1);
  });

  test.each([
    {
      name: 'matrix-exact',
      outboundTarget: 'orchestrator',
      outbound: 'Done.',
      completed: 'Done.',
      expectedTerminal: false,
    },
    {
      name: 'matrix-boundary-whitespace',
      outboundTarget: 'orchestrator',
      outbound: 'Done.\n',
      completed: '  Done.  ',
      expectedTerminal: false,
    },
    {
      name: 'matrix-case',
      outboundTarget: 'orchestrator',
      outbound: 'Done.',
      completed: 'done.',
      expectedTerminal: true,
    },
    {
      name: 'matrix-punctuation',
      outboundTarget: 'orchestrator',
      outbound: 'Done.',
      completed: 'Done!',
      expectedTerminal: true,
    },
    {
      name: 'matrix-internal-whitespace',
      outboundTarget: 'orchestrator',
      outbound: 'two words',
      completed: 'two  words',
      expectedTerminal: true,
    },
    {
      name: 'matrix-peer-target',
      outboundTarget: 'matrix-peer',
      outbound: 'Done.',
      completed: 'Done.',
      expectedTerminal: true,
    },
    {
      name: 'matrix-later-successful-peer',
      outboundTarget: 'orchestrator',
      outbound: 'Done.',
      laterPeerMessage: 'A later peer handoff.',
      completed: 'Done.',
      expectedTerminal: true,
    },
    {
      name: 'matrix-later-failed-peer',
      outboundTarget: 'orchestrator',
      outbound: 'Done.',
      failedPeerMessage: 'This delivery is rejected.',
      completed: 'Done.',
      expectedTerminal: false,
    },
    {
      name: 'matrix-blank-content',
      outboundTarget: 'orchestrator',
      outbound: '   ',
      completed: '   ',
      expectedTerminal: true,
    },
    {
      name: 'matrix-fallback-only',
      outboundTarget: 'orchestrator',
      outbound: 'fallback result',
      fallback: 'fallback result',
      expectedTerminal: true,
    },
    {
      name: 'matrix-forced',
      outboundTarget: 'orchestrator',
      outbound: 'Done.',
      completed: 'Done.',
      exitClassification: 'forced' as const,
      force: true,
      expectedTerminal: true,
    },
    {
      name: 'matrix-provider-failure',
      outboundTarget: 'orchestrator',
      outbound: 'Done.',
      completed: 'Done.',
      exitClassification: 'failed' as const,
      expectedTerminal: true,
    },
  ])(
    'applies the complete duplicate matrix through real mailboxes: $name',
    async ({
      name,
      outboundTarget,
      outbound,
      laterPeerMessage,
      failedPeerMessage,
      completed,
      fallback,
      exitClassification = 'natural',
      force = false,
      expectedTerminal,
    }) => {
      const launcher = new FakeAgentLauncher();
      const rootInput = new FakeAgentInputAdapter();
      rootInput.markReady();
      rootInput.setActiveAccepting();
      const manager = await createManager({
        agentPreparer: createPreparer(),
        agentLauncher: launcher,
        orchestratorInputAdapter: rootInput,
      });
      const peer =
        outboundTarget === 'matrix-peer' ||
        laterPeerMessage !== undefined ||
        failedPeerMessage !== undefined
          ? await startActiveFakeAgent(manager, launcher, 'matrix-peer')
          : undefined;
      const launch = await startActiveFakeAgent(manager, launcher, name);
      const beforeMessages = rootInput.receivedMessages.length;

      const source = launch.request.identity;
      await expect(
        manager.sendAgentMessage(source, { name: outboundTarget, message: outbound })
      ).resolves.toMatchObject({ name: outboundTarget });

      if (laterPeerMessage !== undefined) {
        await expect(
          manager.sendAgentMessage(source, { name: 'matrix-peer', message: laterPeerMessage })
        ).resolves.toMatchObject({ name: 'matrix-peer' });
      }
      if (failedPeerMessage !== undefined) {
        peer?.handle.input.rejectNextDelivery(new Error('intentional peer delivery failure'));
        await expect(
          manager.sendAgentMessage(source, { name: 'matrix-peer', message: failedPeerMessage })
        ).rejects.toMatchObject({ code: 'transport_error' });
      }

      if (fallback !== undefined) {
        await manager.finishAgent(source, { message: fallback });
      }
      if (completed !== undefined) {
        launch.handle.lifecycle.emitCompletedAssistantMessage(completed);
      }
      if (fallback !== undefined) {
        launch.handle.lifecycle.emitTurnComplete();
      }
      if (force) {
        await expect(
          manager.stopAgent(manager.orchestratorIdentity, { name, force: true })
        ).resolves.toMatchObject({ mode: 'forced' });
      }
      launch.handle.lifecycle.emitExit(exitClassification);
      await manager.waitForAgentTerminal(launch.request.identity.id);

      const delivered = rootInput.receivedMessages.slice(beforeMessages);
      const expectedOutboundToRoot = outboundTarget === 'orchestrator' ? 1 : 0;
      expect(delivered).toHaveLength(expectedOutboundToRoot + (expectedTerminal ? 1 : 0));
      if (expectedTerminal) {
        expect(delivered.at(-1)?.source).toMatchObject({ id: launch.request.identity.id, name });
      }
      if (force) {
        expect(delivered.at(-1)?.content).toContain(FORCE_STOP_STALE_CONTEXT_WARNING);
      }
      if (exitClassification === 'failed') {
        expect(delivered.at(-1)?.content).toBe(`Agent ${name} failed before completing.`);
      }
    }
  );

  test('shares one terminal promise and keeps mailbox, slot, and name until cleanup finishes', async () => {
    const session = await createAgentMessagingSessionRuntime();
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    let manager: AgentManager | undefined;
    try {
      manager = await createManager({
        sessionRuntime: session,
        agentPreparer: createPreparer(),
        agentLauncher: launcher,
        orchestratorInputAdapter: rootInput,
      });
      const launch = await startActiveFakeAgent(manager, launcher, 'terminal-cleanup-order');
      const registrationBefore = await session.runtime.listRegistrations();
      expect(registrationBefore.map((entry) => entry.name)).toContain('terminal-cleanup-order');

      launch.handle.deferRelease();
      const deliveryStarted = rootInput.deferNextDelivery();
      const firstTerminalPromise = manager.waitForAgentTerminal(launch.request.identity.id);
      const secondTerminalPromise = manager.waitForAgentTerminal(launch.request.identity.id);
      expect(secondTerminalPromise).toBe(firstTerminalPromise);

      launch.handle.lifecycle.emitExit('natural');
      await deliveryStarted;
      expect(launch.handle.releaseCount).toBe(0);
      expect(manager.getIdentityByName('terminal-cleanup-order')).toBeDefined();

      rootInput.resolveNextDelivery();
      await waitFor(() => launch.handle.releaseCount === 1);
      expect(manager.getIdentityByName('terminal-cleanup-order')).toBeDefined();
      expect(manager.listAgents().agents).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'terminal-cleanup-order' })])
      );
      expect((await session.runtime.listRegistrations()).map((entry) => entry.name)).toContain(
        'terminal-cleanup-order'
      );

      launch.handle.resolveRelease();
      await firstTerminalPromise;
      expect(manager.getIdentityByName('terminal-cleanup-order')).toBeUndefined();
      expect(manager.subagentCount).toBe(0);
      expect(manager.listAgents().agents).toHaveLength(1);
      expect((await session.runtime.listRegistrations()).map((entry) => entry.name)).toEqual([
        'orchestrator',
      ]);

      launch.handle.lifecycle.emitCompletedAssistantMessage('late result');
      launch.handle.lifecycle.emitTurnComplete();
      launch.handle.lifecycle.emitExit('failed', new Error('late failure'));
      await manager.sessionRuntime.deregister(launch.request.identity.id);
      await launch.handle.release();
      expect(rootInput.receivedMessages).toHaveLength(1);
      expect(launch.handle.releaseCount).toBe(1);
    } finally {
      await manager?.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  });

  test('self-finish prefers the completed result and uses fallback only when needed', async () => {
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      orchestratorInputAdapter: rootInput,
    });
    const completed = await startActiveFakeAgent(manager, launcher, 'terminal-self-finish');
    await manager.finishAgent(completed.request.identity, { message: 'fallback' });
    completed.handle.lifecycle.emitCompletedAssistantMessage('completed result');
    completed.handle.lifecycle.emitTurnComplete();
    completed.handle.lifecycle.emitExit('natural');
    await manager.waitForAgentTerminal(completed.request.identity.id);

    const fallback = await startActiveFakeAgent(manager, launcher, 'terminal-fallback');
    await manager.finishAgent(fallback.request.identity, { message: 'fallback result' });
    fallback.handle.lifecycle.emitTurnComplete();
    fallback.handle.lifecycle.emitExit('natural');
    await manager.waitForAgentTerminal(fallback.request.identity.id);

    expect(rootInput.receivedMessages).toHaveLength(2);
    expect(rootInput.receivedMessages[0]?.content).toContain('completed result');
    expect(rootInput.receivedMessages[0]?.content).not.toContain('fallback');
    expect(rootInput.receivedMessages[1]?.content).toContain('fallback result');
  });

  test('forced completion always sends only the completed result and warning', async () => {
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      orchestratorInputAdapter: rootInput,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'terminal-forced');
    launch.handle.lifecycle.emitCompletedAssistantMessage('last completed result');
    launch.handle.lifecycle.emitOutputActivity();

    await expect(
      manager.stopAgent(manager.orchestratorIdentity, {
        name: 'terminal-forced',
        message: 'shutdown context must not leak',
        force: true,
      })
    ).resolves.toMatchObject({ mode: 'forced' });
    launch.handle.lifecycle.emitExit('forced');
    await manager.waitForAgentTerminal(launch.request.identity.id);

    expect(rootInput.receivedMessages).toHaveLength(1);
    expect(rootInput.receivedMessages[0]?.content).toBe(
      `last completed result\n\n${FORCE_STOP_STALE_CONTEXT_WARNING}`
    );
    expect(rootInput.receivedMessages[0]?.content).not.toContain('shutdown context');
  });

  test('forced completion reports the explicit no-result marker', async () => {
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      orchestratorInputAdapter: rootInput,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'terminal-forced-empty');
    await manager.stopAgent(manager.orchestratorIdentity, {
      name: 'terminal-forced-empty',
      force: true,
    });
    launch.handle.lifecycle.emitExit('forced');
    await manager.waitForAgentTerminal(launch.request.identity.id);

    expect(rootInput.receivedMessages[0]?.content).toBe(
      `${NO_COMPLETED_ASSISTANT_MESSAGE}\n\n${FORCE_STOP_STALE_CONTEXT_WARNING}`
    );
  });

  test('graceful provider exit uses the normal terminal notification policy', async () => {
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      orchestratorInputAdapter: rootInput,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'terminal-graceful');
    await manager.stopAgent(manager.orchestratorIdentity, {
      name: 'terminal-graceful',
      message: 'final context',
    });
    launch.handle.lifecycle.emitCompletedAssistantMessage('graceful result');
    launch.handle.lifecycle.emitExit('graceful');
    await manager.waitForAgentTerminal(launch.request.identity.id);

    expect(rootInput.receivedMessages).toHaveLength(1);
    expect(rootInput.receivedMessages[0]?.content).toContain('graceful result');
    expect(rootInput.receivedMessages[0]?.content).not.toContain('final context');
  });

  test('uses a graceful provider classification when an unaccepted force races provider exit', async () => {
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      orchestratorInputAdapter: rootInput,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'terminal-graceful-force-race');
    await manager.stopAgent(manager.orchestratorIdentity, {
      name: 'terminal-graceful-force-race',
    });
    await flushLifecyclePromises();

    const forceStarted = launch.handle.lifecycle.deferNextForcedShutdown();
    const force = manager.stopAgent(manager.orchestratorIdentity, {
      name: 'terminal-graceful-force-race',
      force: true,
    });
    await forceStarted;
    launch.handle.lifecycle.emitCompletedAssistantMessage('gracefully completed result');
    launch.handle.lifecycle.emitExit('graceful');
    launch.handle.lifecycle.resolveForcedShutdown({ accepted: false, alreadyExited: true });

    await expect(force).resolves.toMatchObject({ mode: 'forced' });
    await manager.waitForAgentTerminal(launch.request.identity.id);
    expect(rootInput.receivedMessages).toHaveLength(1);
    expect(rootInput.receivedMessages[0]?.content).toContain('gracefully completed result');
    expect(rootInput.receivedMessages[0]?.content).not.toContain(FORCE_STOP_STALE_CONTEXT_WARNING);
  });

  test('reports a natural and graceful no-result status without exposing intermediate output', async () => {
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      orchestratorInputAdapter: rootInput,
    });

    const natural = await startActiveFakeAgent(manager, launcher, 'terminal-no-result-natural');
    natural.handle.lifecycle.emitOutputActivity();
    natural.handle.lifecycle.emitExit('natural');
    await manager.waitForAgentTerminal(natural.request.identity.id);

    const graceful = await startActiveFakeAgent(manager, launcher, 'terminal-no-result-graceful');
    await manager.stopAgent(manager.orchestratorIdentity, {
      name: 'terminal-no-result-graceful',
      message: 'shutdown instruction must not become a result',
    });
    graceful.handle.lifecycle.emitOutputActivity();
    graceful.handle.lifecycle.emitExit('graceful');
    await manager.waitForAgentTerminal(graceful.request.identity.id);

    expect(rootInput.receivedMessages).toHaveLength(2);
    expect(rootInput.receivedMessages[0]?.content).toContain(NO_COMPLETED_ASSISTANT_MESSAGE);
    expect(rootInput.receivedMessages[1]?.content).toContain(NO_COMPLETED_ASSISTANT_MESSAGE);
    expect(rootInput.receivedMessages[1]?.content).not.toContain('shutdown instruction');
  });

  test('natural exit wins a force race when the provider proves it exited naturally', async () => {
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      orchestratorInputAdapter: rootInput,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'terminal-natural-race');
    launch.handle.lifecycle.emitCompletedAssistantMessage('natural result');
    const forceStarted = launch.handle.lifecycle.deferNextForcedShutdown();
    const force = manager.stopAgent(manager.orchestratorIdentity, {
      name: 'terminal-natural-race',
      force: true,
    });
    launch.handle.lifecycle.emitExit('natural');
    launch.handle.lifecycle.resolveForcedShutdown();
    await forceStarted;
    await force;
    await manager.waitForAgentTerminal(launch.request.identity.id);

    expect(rootInput.receivedMessages).toHaveLength(1);
    expect(rootInput.receivedMessages[0]?.content).toContain(
      'Agent terminal-natural-race completed.'
    );
    expect(rootInput.receivedMessages[0]?.content).not.toContain(FORCE_STOP_STALE_CONTEXT_WARNING);
  });

  test('delivery and provider cleanup failures do not retry or leave the record pending', async () => {
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    rootInput.setPersistentDeliveryRejection(new Error('root delivery failed'));
    const manager = await createManager({
      agentPreparer: createPreparer(),
      agentLauncher: launcher,
      orchestratorInputAdapter: rootInput,
    });
    const launch = await startActiveFakeAgent(manager, launcher, 'terminal-failures');
    launch.handle.setReleaseFailure(new Error('provider release failed'));
    launch.handle.lifecycle.emitExit('failed', new Error('raw provider detail'));
    await manager.waitForAgentTerminal(launch.request.identity.id);

    expect(manager.getAgentSnapshot(launch.request.identity.id)).toBeUndefined();
    expect(launch.handle.releaseCount).toBe(1);
    expect(rootInput.receivedMessages).toHaveLength(0);
    expect(launch.handle.lifecycle.forcedShutdownCalls).toBe(0);
  });

  test('resolves the terminal promise when mailbox deregistration reports cleanup failure', async () => {
    const session = await createAgentMessagingSessionRuntime();
    const originalRegister = session.register.bind(session);
    let deregisterCalls = 0;
    vi.spyOn(session, 'register').mockImplementation(async (options) => {
      const registration = await originalRegister(options);
      if (options.registration.name === 'terminal-mailbox-cleanup-failure') {
        const originalDeregister = registration.deregister.bind(registration);
        registration.deregister = async (): Promise<void> => {
          deregisterCalls += 1;
          await originalDeregister();
          throw new Error('reported mailbox cleanup failure');
        };
      }
      return registration;
    });

    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    let manager: AgentManager | undefined;
    try {
      manager = await createManager({
        sessionRuntime: session,
        agentPreparer: createPreparer(),
        agentLauncher: launcher,
        orchestratorInputAdapter: rootInput,
      });
      const launch = await startActiveFakeAgent(
        manager,
        launcher,
        'terminal-mailbox-cleanup-failure'
      );
      launch.handle.lifecycle.emitExit('natural');

      await manager.waitForAgentTerminal(launch.request.identity.id);
      expect(deregisterCalls).toBe(1);
      expect(manager.getIdentityByName('terminal-mailbox-cleanup-failure')).toBeUndefined();
      expect(manager.subagentCount).toBe(0);
      expect((await session.runtime.listRegistrations()).map((entry) => entry.name)).toEqual([
        'orchestrator',
      ]);

      await manager.waitForAgentTerminal(launch.request.identity.id);
      expect(deregisterCalls).toBe(1);
      expect(launch.handle.releaseCount).toBe(1);
    } finally {
      await manager?.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  });

  test('fans out root teardown and keeps inactivity timers independent', async () => {
    const session = await createAgentMessagingSessionRuntime();
    const launcher = new FakeAgentLauncher();
    const scheduler = new FakeAgentManagerScheduler();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    let manager: AgentManager | undefined;
    try {
      manager = await createManager({
        sessionRuntime: session,
        agentPreparer: createPreparer(),
        agentLauncher: launcher,
        orchestratorInputAdapter: rootInput,
        scheduler,
      });
      const quick = await startActiveFakeAgent(manager, launcher, 'teardown-quick');
      const chatty = await startActiveFakeAgent(manager, launcher, 'teardown-chatty');
      const silent = await startActiveFakeAgent(manager, launcher, 'teardown-silent');

      const teardown = manager.close();
      expect(manager.close()).toBe(teardown);
      expect(
        launcher.launches.map((launch) => launch.handle.lifecycle.gracefulShutdownCalls)
      ).toEqual([1, 1, 1]);
      expect(manager.listAgents().agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'teardown-quick', state: 'stopping' }),
          expect.objectContaining({ name: 'teardown-chatty', state: 'stopping' }),
          expect.objectContaining({ name: 'teardown-silent', state: 'stopping' }),
        ])
      );
      await expect(
        manager.startAgent(manager.orchestratorIdentity, reservationRequest('after-teardown'))
      ).rejects.toMatchObject({ code: 'manager_closed' });

      await flushLifecyclePromises();
      quick.handle.lifecycle.emitExit('natural');
      scheduler.advanceBy(90_000);
      chatty.handle.lifecycle.emitOutputActivity();
      scheduler.advanceBy(30_000);
      expect(silent.handle.lifecycle.forcedShutdownCalls).toBe(1);
      expect(chatty.handle.lifecycle.forcedShutdownCalls).toBe(0);

      silent.handle.lifecycle.emitExit('forced');
      scheduler.advanceBy(90_000);
      expect(chatty.handle.lifecycle.forcedShutdownCalls).toBe(1);
      chatty.handle.lifecycle.emitExit('forced');

      await teardown;
      expect(manager.listAgents().agents).toEqual([]);
      expect(await session.runtime.listRegistrations()).toEqual([]);
      expect(quick.handle.lifecycle.forcedShutdownCalls).toBe(0);
    } finally {
      await manager?.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  });

  test('keeps root resources open until the final notification and cleanup settle', async () => {
    const session = await createAgentMessagingSessionRuntime();
    const cleanupRegistry = CleanupRegistry.getInstance();
    const cleanupHandlersBeforeManager = cleanupRegistry.size;
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    let manager: AgentManager | undefined;
    try {
      manager = await createManager({
        sessionRuntime: session,
        agentPreparer: createPreparer(),
        agentLauncher: launcher,
        orchestratorInputAdapter: rootInput,
      });
      expect(cleanupRegistry.size).toBe(cleanupHandlersBeforeManager + 1);
      const launch = await startActiveFakeAgent(manager, launcher, 'teardown-notification');
      const deliveryStarted = rootInput.deferNextDelivery();
      const teardown = manager.close();
      launch.handle.lifecycle.emitCompletedAssistantMessage('final teardown result');
      launch.handle.lifecycle.emitExit('natural');
      await deliveryStarted;

      expect(launch.handle.releaseCount).toBe(0);
      expect((await session.runtime.listRegistrations()).map((entry) => entry.name)).toEqual(
        expect.arrayContaining(['orchestrator', 'teardown-notification'])
      );

      rootInput.resolveNextDelivery();
      await teardown;
      expect(launch.handle.releaseCount).toBe(1);
      expect(await session.runtime.listRegistrations()).toEqual([]);
      expect(cleanupRegistry.size).toBe(cleanupHandlersBeforeManager);
    } finally {
      await manager?.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  });

  test('waits for a starting provider to fail or become terminal during teardown', async () => {
    const session = await createAgentMessagingSessionRuntime();
    const launcher = new FakeAgentLauncher();
    const preparationStarted = deferred<void>();
    const preparation = deferred<PreparedAgentExecution>();
    let preparationRequest: AgentPreparationRequest | undefined;
    const preparer = {
      prepare: async (request: AgentPreparationRequest): Promise<PreparedAgentExecution> => {
        preparationRequest = request;
        preparationStarted.resolve(undefined);
        await preparation.promise;
        return preparedExecutionFor(request);
      },
    };
    let manager: AgentManager | undefined;
    try {
      manager = await createManager({
        sessionRuntime: session,
        agentPreparer: preparer,
        agentLauncher: launcher,
      });
      const start = manager.startAgent(
        manager.orchestratorIdentity,
        reservationRequest('teardown-starting')
      );
      await preparationStarted.promise;
      const teardown = manager.close();
      preparation.resolve(preparedExecutionFor(preparationRequest as AgentPreparationRequest));
      const launch = await launcher.waitForNextLaunch();
      launch.handle.markReady();
      await expect(start).resolves.toMatchObject({
        name: 'teardown-starting',
        state: 'stopping',
      });
      expect(launch.handle.lifecycle.gracefulShutdownCalls).toBe(1);
      launch.handle.lifecycle.emitExit('graceful');
      await teardown;
      expect(manager.listAgents().agents).toEqual([]);
    } finally {
      await manager?.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  });

  test('continues root teardown after an automatic force failure', async () => {
    const session = await createAgentMessagingSessionRuntime();
    const launcher = new FakeAgentLauncher();
    const scheduler = new FakeAgentManagerScheduler();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    let manager: AgentManager | undefined;
    try {
      manager = await createManager({
        sessionRuntime: session,
        agentPreparer: createPreparer(),
        agentLauncher: launcher,
        orchestratorInputAdapter: rootInput,
        scheduler,
      });
      const launch = await startActiveFakeAgent(manager, launcher, 'teardown-force-failure');
      launch.handle.lifecycle.failNextForcedShutdown();
      const teardown = manager.close();
      await flushLifecyclePromises();
      scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS);

      expect(launch.handle.lifecycle.forcedShutdownCalls).toBe(1);
      expect(launch.handle.releaseCount).toBe(0);
      expect(manager.getIdentityByName('teardown-force-failure')).toBeDefined();

      launch.handle.lifecycle.emitExit('graceful');
      await teardown;
      expect(launch.handle.releaseCount).toBe(1);
    } finally {
      await manager?.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  });

  test('cleans up after a terminal notification delivery failure during teardown', async () => {
    const session = await createAgentMessagingSessionRuntime();
    const launcher = new FakeAgentLauncher();
    const rootInput = new FakeAgentInputAdapter();
    rootInput.markReady();
    rootInput.setActiveAccepting();
    rootInput.setPersistentDeliveryRejection(new Error('root notification unavailable'));
    let manager: AgentManager | undefined;
    try {
      manager = await createManager({
        sessionRuntime: session,
        agentPreparer: createPreparer(),
        agentLauncher: launcher,
        orchestratorInputAdapter: rootInput,
      });
      const launch = await startActiveFakeAgent(manager, launcher, 'teardown-notification-failure');
      const teardown = manager.close();
      launch.handle.lifecycle.emitExit('natural');
      await teardown;

      expect(launch.handle.releaseCount).toBe(1);
      expect(manager.listAgents().agents).toEqual([]);
      expect(await session.runtime.listRegistrations()).toEqual([]);
    } finally {
      await manager?.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  });
});
