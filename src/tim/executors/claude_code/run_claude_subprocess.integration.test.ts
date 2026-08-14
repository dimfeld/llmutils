import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

import {
  runWithSessionProcessOwner,
  SessionProcessOwner,
} from '../../../common/session_process_control.js';
import {
  SessionProcessRegistry,
  SessionProcessRegistryLifecycleSink,
  toProcessId,
  type ProcessId,
} from '../../../common/session_process.js';
import { closeDatabaseForTesting } from '../../db/database.js';
import { AgentManager } from '../../agent_messaging/agent_manager.js';
import type {
  AgentCallerIdentity,
  AgentLaunchHandle,
  AgentLauncher,
  AgentManagerOptions,
  PreparedAgentExecution,
} from '../../agent_messaging/agent_manager_types.js';
import type { FormattedClaudeMessage } from './format.js';
import { runClaudeSubprocess } from './run_claude_subprocess.js';
import type { ClaudePersistentAgentLaunchHandle } from './persistent_agent_contract.js';

const fixturePath = fileURLToPath(
  new URL('./test-fixtures/stream-json-claude-fixture.mjs', import.meta.url)
);

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

type AgentTestRecord = {
  readonly messages: FormattedClaudeMessage[];
  activityCount: number;
  handle?: ClaudePersistentAgentLaunchHandle;
};

const records = new Map<string, AgentTestRecord>();
const startupQueueAcknowledgements = new Map<string, Promise<{ readonly delivery: string }>>();
let manager: AgentManager | undefined;
let owner: SessionProcessOwner | undefined;
let configRoot: string | undefined;
let originalConfigHome: string | undefined;

afterEach(async () => {
  if (manager !== undefined && !manager.isClosed) {
    const liveAgents = manager.listAgents().agents.filter((agent) => agent.name !== 'orchestrator');
    await Promise.all(
      liveAgents.map(async (agent) => {
        try {
          await manager!.stopAgent(
            { id: manager!.orchestratorIdentity.id, role: 'orchestrator' },
            { name: agent.name, force: true }
          );
        } catch {
          // The test may already have completed this agent during its assertions.
        }
      })
    );
  }
  await manager?.close().catch(() => undefined);
  manager = undefined;
  owner?.dispose();
  owner = undefined;
  closeDatabaseForTesting();
  if (configRoot !== undefined) {
    await fs.rm(configRoot, { recursive: true, force: true });
    configRoot = undefined;
  }
  if (originalConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalConfigHome;
  }
  originalConfigHome = undefined;
  records.clear();
  startupQueueAcknowledgements.clear();
}, 60_000);

function processId(value: string): ProcessId {
  const result = toProcessId(value);
  if (result === undefined) throw new Error(`Invalid process ID: ${value}`);
  return result;
}

function makePreparedExecution(
  type: PreparedAgentExecution['agentType'],
  executor: PreparedAgentExecution['executor'],
  initialMessage: string
): PreparedAgentExecution {
  return {
    agentType: type,
    executor,
    model: undefined,
    plan: {} as PreparedAgentExecution['plan'],
    planId: 1,
    planPath: process.cwd(),
    gitRoot: process.cwd(),
    useJj: true,
    prompt: initialMessage,
    config: {} as PreparedAgentExecution['config'],
    timEnvironment: {},
  };
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function agentCaller(name: string): AgentCallerIdentity {
  const identity = manager?.getIdentityByName(name);
  if (identity === undefined || identity.role !== 'subagent') {
    throw new Error(`Missing subagent identity for ${name}`);
  }
  return { id: identity.id, role: identity.role };
}

async function createManager(): Promise<{
  readonly rootCaller: AgentCallerIdentity;
  readonly registry: SessionProcessRegistry;
}> {
  configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-claude-fixture-config-'));
  originalConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configRoot;

  const registry = new SessionProcessRegistry({ sessionId: 'claude-fixture-session' });
  const ownerProcessId = processId('claude-fixture-owner');
  registry.register({ processId: ownerProcessId, kind: 'tim', label: 'fixture owner' });
  owner = new SessionProcessOwner({
    sessionId: 'claude-fixture-session',
    ownerProcessId,
    lifecycleSink: new SessionProcessRegistryLifecycleSink(registry),
  });

  const agentLauncher: AgentLauncher = {
    launch: async (request): Promise<AgentLaunchHandle> => {
      const record: AgentTestRecord = { messages: [], activityCount: 0 };
      records.set(request.identity.name, record);
      const handle = await runWithSessionProcessOwner(owner!, () =>
        runClaudeSubprocess({
          mode: 'persistent-agent',
          prompt: request.initialMessage,
          cwd: process.cwd(),
          claudeExecutable: fixturePath,
          claudeCodeOptions: {
            allowAllTools: true,
            includeDefaultTools: false,
            permissionsMcp: { enabled: false },
          },
          noninteractive: true,
          terminalInput: false,
          label: request.identity.name,
          processLabel: request.processLabel,
          persistentTurnGraceMs: 20,
          processFormattedMessages: (messages): void => {
            record.messages.push(...messages);
          },
          onOutputActivity: (): void => {
            record.activityCount += 1;
          },
        })
      );
      record.handle = handle;
      if (request.identity.name === 'claude-b' && manager !== undefined) {
        const queued = manager.sendAgentMessage(
          { id: manager.orchestratorIdentity.id, role: 'orchestrator' },
          { name: request.identity.name, message: 'queued-during-launch' }
        );
        startupQueueAcknowledgements.set(request.identity.name, queued);
        await queued;
      }
      return handle;
    },
  };

  const options: AgentManagerOptions = {
    orchestratorExecutor: 'claude-code',
    agentPreparer: {
      prepare: async ({ identity, initialMessage }): Promise<PreparedAgentExecution> =>
        makePreparedExecution(identity.type, identity.executor, initialMessage),
    },
    agentLauncher,
  };
  manager = await AgentManager.create(options);
  return {
    rootCaller: { id: manager.orchestratorIdentity.id, role: 'orchestrator' },
    registry,
  };
}

function assistantTexts(name: string): string[] {
  return (records.get(name)?.messages ?? [])
    .filter((message) => message.type === 'assistant')
    .map((message) => message.rawMessage ?? '');
}

describeUnix('persistent Claude real-process integration', () => {
  test('runs concurrent agents through real pipes, mailboxes, lifecycle controls, and cleanup', async () => {
    const { rootCaller, registry } = await createManager();
    const sessionRoot = manager!.sessionRuntime.runtime.rootPath;

    const [agentA, agentB] = await Promise.all([
      manager!.startAgent(rootCaller, {
        name: 'claude-a',
        type: 'implementer',
        executor: 'claude-code',
        initialMessage: 'background-start',
      }),
      manager!.startAgent(rootCaller, {
        name: 'claude-b',
        type: 'tester',
        executor: 'claude-code',
        initialMessage: 'hold',
      }),
    ]);

    expect(agentA.state).toBe('running-active');
    expect(agentB.state).toBe('running-active');
    expect(agentA.id).not.toBe(agentB.id);

    await waitFor(
      () =>
        manager!
          .listAgents()
          .agents.filter((agent) => agent.name !== 'orchestrator')
          .every((agent) => agent.state === 'running-active'),
      'both initial turns to be active'
    );

    await expect(startupQueueAcknowledgements.get('claude-b')).resolves.toMatchObject({
      delivery: 'queued',
    });

    await waitFor(
      () =>
        manager!.listAgents().agents.find((agent) => agent.name === 'claude-b')?.state ===
        'running-idle',
      'the launch-time FIFO message to settle'
    );

    const activeTurn = await manager!.sendAgentMessage(rootCaller, {
      name: 'claude-b',
      message: 'hold',
    });
    expect(activeTurn.delivery).toBe('started-idle-turn');
    const activeSteering = await manager!.sendAgentMessage(rootCaller, {
      name: 'claude-b',
      message: 'steer-b',
    });
    expect(activeSteering.delivery).toBe('steered');

    await waitFor(
      () =>
        manager!.listAgents().agents.find((agent) => agent.name === 'claude-b')?.state ===
        'running-idle',
      'active steering to settle into an idle turn'
    );

    const idleRace = await Promise.all([
      manager!.sendAgentMessage(rootCaller, { name: 'claude-b', message: 'race-hold' }),
      manager!.sendAgentMessage(rootCaller, { name: 'claude-b', message: 'race-follow-up' }),
    ]);
    expect(
      idleRace.filter((acknowledgement) => acknowledgement.delivery === 'started-idle-turn')
    ).toHaveLength(1);
    expect(
      idleRace.filter((acknowledgement) => acknowledgement.delivery !== 'started-idle-turn')
    ).toHaveLength(1);
    expect(['steered', 'queued']).toContain(
      idleRace.find((acknowledgement) => acknowledgement.delivery !== 'started-idle-turn')?.delivery
    );
    await waitFor(
      () =>
        manager!.listAgents().agents.find((agent) => agent.name === 'claude-b')?.state ===
        'running-active',
      'the concurrent idle-start messages to claim one active turn'
    );

    const bTexts = assistantTexts('claude-b');
    expect(bTexts[0]).toMatch(/:held$/);
    expect(bTexts.slice(1, 4)).toEqual([
      expect.stringContaining(':queued-during-launch'),
      expect.stringContaining(':held'),
      expect.stringContaining(':steer-b'),
    ]);

    const invalidate = await manager!.sendAgentMessage(rootCaller, {
      name: 'claude-a',
      message: 'background-invalidate',
    });
    expect(['steered', 'started-idle-turn', 'queued']).toContain(invalidate.delivery);
    await waitFor(
      () => assistantTexts('claude-a').some((text) => text.endsWith(':background-invalidated')),
      'background result invalidation'
    );
    expect(manager!.listAgents().agents.find((agent) => agent.name === 'claude-a')?.state).toBe(
      'running-active'
    );

    const drain = await manager!.sendAgentMessage(rootCaller, {
      name: 'claude-a',
      message: 'background-drain',
    });
    expect(['steered', 'queued']).toContain(drain.delivery);
    await waitFor(
      () =>
        manager!.listAgents().agents.find((agent) => agent.name === 'claude-a')?.state ===
        'running-idle',
      'background work to settle after the drain grace'
    );

    const nextTurn = await manager!.sendAgentMessage(rootCaller, {
      name: 'claude-a',
      message: 'a-next',
    });
    expect(nextTurn.delivery).toBe('started-idle-turn');
    await waitFor(
      () =>
        manager!.listAgents().agents.find((agent) => agent.name === 'claude-a')?.state ===
        'running-idle',
      'Claude A continuation to settle'
    );

    const finishTurn = manager!.sendAgentMessage(rootCaller, {
      name: 'claude-a',
      message: 'finish-hold',
    });
    await finishTurn;
    const finishResult = await manager!.finishAgent(agentCaller('claude-a'), {
      message: 'Claude A finished its integration assignment.',
    });
    expect(finishResult.state).toBe('finishing');
    await manager!.waitForAgentTerminal(agentA.id);

    const forced = await manager!.stopAgent(rootCaller, { name: 'claude-b', force: true });
    expect(forced.mode).toBe('forced');
    await manager!.waitForAgentTerminal(agentB.id);

    const unexpected = await manager!.startAgent(rootCaller, {
      name: 'claude-exit',
      type: 'tester',
      executor: 'claude-code',
      initialMessage: 'exit-idle',
    });
    await manager!.waitForAgentTerminal(unexpected.id);

    const aCompletion = await records.get('claude-a')?.handle?.completion;
    const bCompletion = await records.get('claude-b')?.handle?.completion;
    const exitCompletion = await records.get('claude-exit')?.handle?.completion;
    expect(aCompletion).toMatchObject({
      exitCode: 0,
      resultText: expect.stringContaining(':finish-pending'),
      lastCompletedAssistantMessage: expect.stringContaining(':finish-pending'),
    });
    expect(bCompletion?.signal).toBe('SIGTERM');
    expect(exitCompletion).toMatchObject({
      exitCode: 0,
      resultText: expect.stringContaining(':exit-idle'),
    });

    expect(records.get('claude-a')?.activityCount).toBeGreaterThan(0);
    expect(records.get('claude-b')?.activityCount).toBeGreaterThan(0);

    const processNodes = registry
      .getSnapshot()
      .filter((node) => node.kind === 'executor')
      .sort((left, right) => left.label.localeCompare(right.label));
    expect(processNodes.map((node) => node.label)).toEqual([
      'Claude agent (claude-a)',
      'Claude agent (claude-b)',
      'Claude agent (claude-exit)',
    ]);
    expect(new Set(processNodes.map((node) => node.pid)).size).toBe(3);
    expect(new Set(processNodes.map((node) => node.processId)).size).toBe(3);

    expect(manager!.listAgents().agents).toEqual([
      expect.objectContaining({ name: 'orchestrator' }),
    ]);
    await manager!.close();
    expect(owner!.childCount).toBe(0);
    expect(manager!.sessionRuntime.isClosed).toBe(true);
    await expect(fs.access(sessionRoot)).rejects.toThrow();
    const remainingClaudeTempDirs = (await fs.readdir(os.tmpdir())).filter((entry) =>
      /^tim-claude-(a|b|exit)-/.test(entry)
    );
    expect(remainingClaudeTempDirs).toEqual([]);
  }, 60_000);

  test('gracefully stops a real Claude fixture and settles provider completion', async () => {
    const { rootCaller } = await createManager();
    const agent = await manager!.startAgent(rootCaller, {
      name: 'claude-graceful',
      type: 'implementer',
      executor: 'claude-code',
      initialMessage: 'hold',
    });

    await waitFor(
      () =>
        manager!.listAgents().agents.find((entry) => entry.name === 'claude-graceful')?.state ===
        'running-active',
      'the graceful-stop fixture turn to be active'
    );

    await expect(
      manager!.stopAgent(rootCaller, {
        name: 'claude-graceful',
        message: 'Report the final fixture status before stopping.',
      })
    ).resolves.toMatchObject({
      mode: 'graceful-requested',
      state: 'stopping',
    });

    await manager!.waitForAgentTerminal(agent.id);

    expect(assistantTexts('claude-graceful')).toEqual(
      expect.arrayContaining([expect.stringMatching(/:held$/), expect.stringMatching(/:shutdown$/)])
    );
    await expect(records.get('claude-graceful')?.handle?.completion).resolves.toMatchObject({
      exitCode: 0,
      resultText: expect.stringMatching(/:shutdown$/),
      lastCompletedAssistantMessage: expect.stringMatching(/:shutdown$/),
    });

    expect(manager!.listAgents().agents).toEqual([
      expect.objectContaining({ name: 'orchestrator' }),
    ]);
    await manager!.close();
  }, 60_000);
});
