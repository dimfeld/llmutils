import { promises as fs } from 'node:fs';
import * as os from 'node:os';

import { afterEach, describe, expect, test } from 'vitest';

import {
  AGENT_MESSAGING_RUNTIME_PREFIX,
  MAX_AGENT_NAME_LENGTH,
  MAX_SUBAGENTS_PER_SESSION,
  ORCHESTRATOR_AGENT_NAME,
} from './contracts.js';
import { AgentManagerError, createAgentManager } from './index.js';
import { FakeAgentInputAdapter, FakeAgentLauncher } from './fake_provider.js';
import { formatAgentProcessLabel } from './agent_process_labels.js';
import { createAgentMessagingSessionRuntime } from './session_runtime.js';
import { getDefaultConfig } from '../configSchema.js';
import type { AgentLaunchRequest, PreparedAgentExecution } from './agent_manager_types.js';
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

async function createManager(
  options: Parameters<typeof createAgentManager>[0] = {}
): Promise<AgentManager> {
  const manager = await createAgentManager({ agentIdGenerator: idGenerator(), ...options });
  managers.push(manager);
  return manager;
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

describe('provider-neutral launch contracts and test fakes', () => {
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
