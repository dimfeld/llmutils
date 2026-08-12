import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TimConfig } from '../../configSchema.js';
import {
  createAgentManager,
  type AgentManager,
  type AgentPreparation,
  type PreparedAgentExecution,
} from '../../agent_messaging/index.js';
import { FakeAgentInputAdapter } from '../../agent_messaging/fake_provider.js';
import {
  runWithSessionProcessOwner,
  SessionProcessOwner,
} from '../../../common/session_process_control.js';
import {
  SessionProcessRegistry,
  SessionProcessRegistryLifecycleSink,
  toProcessId,
} from '../../../common/session_process.js';
import { createCodexAgentLauncher } from './codex_agent_launcher.js';
import { TIM_CODEX_APP_SERVER_SOCKET } from './app_server_connection.js';

interface Fixture {
  readonly rootDir: string;
  readonly serverPath: string;
  readonly codexPath: string;
  readonly spawnLogPath: string;
  readonly requestLogPath: string;
}

interface TestOwner {
  readonly owner: SessionProcessOwner;
  readonly registry: SessionProcessRegistry;
  readonly rootProcessId: string;
}

const originalEnvironment = {
  PATH: process.env.PATH,
  socket: process.env[TIM_CODEX_APP_SERVER_SOCKET],
  serverPath: process.env.PERSISTENT_CODEX_SERVER_PATH,
  spawnLog: process.env.PERSISTENT_CODEX_SPAWN_LOG,
  requestLog: process.env.PERSISTENT_CODEX_REQUEST_LOG,
};

afterEach(() => {
  restoreEnvironment();
});

async function createFixture(): Promise<Fixture> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-manager-production-'));
  const serverPath = path.join(rootDir, 'mock-app-server.ts');
  const codexPath = path.join(rootDir, 'codex');
  const spawnLogPath = path.join(rootDir, 'spawn.log');
  const requestLogPath = path.join(rootDir, 'requests.jsonl');

  await Promise.all([
    fs.writeFile(spawnLogPath, ''),
    fs.writeFile(requestLogPath, ''),
    fs.writeFile(
      serverPath,
      `#!/usr/bin/env bun
import * as fs from 'node:fs';

const requestLogPath = process.env.PERSISTENT_CODEX_REQUEST_LOG;
const threadId = 'thread-' + process.pid;
let turnNumber = 0;
let currentTurnId = '';

function append(filePath, value) {
  if (filePath) fs.appendFileSync(filePath, JSON.stringify(value) + '\\n');
}

function send(websocket, value) {
  websocket.send(JSON.stringify(value));
}

function completeCurrentTurn(websocket) {
  send(websocket, {
    jsonrpc: '2.0',
    method: 'item/completed',
    params: {
      threadId,
      turnId: currentTurnId,
      item: { type: 'agentMessage', text: 'Completed ' + currentTurnId },
    },
  });
  send(websocket, {
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: { threadId, turn: { id: currentTurnId, status: 'completed' } },
  });
}

const listenIndex = process.argv.indexOf('--listen');
const listenValue = listenIndex >= 0 ? process.argv[listenIndex + 1] : undefined;
const socketPath = listenValue && listenValue.startsWith('unix://')
  ? listenValue.slice('unix://'.length)
  : undefined;
if (!socketPath) throw new Error('missing private app-server socket');

const server = Bun.serve({
  unix: socketPath,
  fetch(request, serverHandle) {
    if (serverHandle.upgrade(request)) return;
    return new Response('Expected websocket upgrade', { status: 426 });
  },
  websocket: {
    message(websocket, rawMessage) {
      const message = JSON.parse(String(rawMessage));
      if (!message.method) return;
      append(requestLogPath, { pid: process.pid, ...message });

      if (message.method === 'initialize') {
        send(websocket, { jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
        return;
      }
      if (message.method === 'thread/start') {
        send(websocket, { jsonrpc: '2.0', id: message.id, result: { threadId } });
        return;
      }
      if (message.method === 'turn/start') {
        currentTurnId = 'turn-' + (++turnNumber);
        // Exercise the notification-before-response ordering supported by the
        // persistent adapter on every turn.
        send(websocket, {
          jsonrpc: '2.0',
          method: 'turn/started',
          params: { threadId, turn: { id: currentTurnId } },
        });
        send(websocket, { jsonrpc: '2.0', id: message.id, result: { turnId: currentTurnId } });
        if (turnNumber > 1) setTimeout(() => completeCurrentTurn(websocket), 0);
        return;
      }
      if (message.method === 'turn/steer') {
        send(websocket, { jsonrpc: '2.0', id: message.id, result: { turnId: currentTurnId } });
        setTimeout(() => completeCurrentTurn(websocket), 0);
        return;
      }
      if (message.method === 'turn/interrupt') {
        send(websocket, { jsonrpc: '2.0', id: message.id, result: {} });
      }
    },
  },
});
void server;
`
    ),
    fs.writeFile(
      codexPath,
      `#!/bin/sh
printf 'pid=%s\\nargs:' "$$" >> "$PERSISTENT_CODEX_SPAWN_LOG"
for arg in "$@"; do printf '\\t%s' "$arg" >> "$PERSISTENT_CODEX_SPAWN_LOG"; done
printf '\\n%s=%s\\n' '${TIM_CODEX_APP_SERVER_SOCKET}' "$TIM_CODEX_APP_SERVER_SOCKET" >> "$PERSISTENT_CODEX_SPAWN_LOG"
exec bun "$PERSISTENT_CODEX_SERVER_PATH" "$@"
`
    ),
  ]);
  await Promise.all([fs.chmod(serverPath, 0o755), fs.chmod(codexPath, 0o755)]);
  return { rootDir, serverPath, codexPath, spawnLogPath, requestLogPath };
}

function createOwner(): TestOwner {
  const registry = new SessionProcessRegistry({ sessionId: `codex-manager-${Date.now()}` });
  const rootProcessId = toProcessId('codex-manager-root');
  if (!rootProcessId) throw new Error('Invalid test root process ID');
  if (
    registry.register({
      processId: rootProcessId,
      kind: 'tim',
      label: 'codex manager test root',
      state: 'running',
    }) === undefined
  ) {
    throw new Error('Could not register test root process');
  }
  return {
    owner: new SessionProcessOwner({
      sessionId: registry.sessionId!,
      ownerProcessId: rootProcessId,
      lifecycleSink: new SessionProcessRegistryLifecycleSink(registry),
    }),
    registry,
    rootProcessId,
  };
}

function createPreparation(cwd: string): AgentPreparation {
  return {
    prepare: async ({ identity, initialMessage }): Promise<PreparedAgentExecution> => ({
      agentType: identity.type,
      executor: identity.executor,
      model: 'gpt-5.6-sol:high',
      plan: {} as PreparedAgentExecution['plan'],
      planId: 420,
      planPath: '/repo/.tim/plans/420.plan.md',
      gitRoot: cwd,
      useJj: true,
      prompt: `Prepared ${initialMessage}`,
      config: {} as TimConfig,
      timEnvironment: {
        context: { planId: 420 },
      },
    }),
  };
}

function setFixtureEnvironment(fixture: Fixture): void {
  process.env.PATH = `${fixture.rootDir}:${originalEnvironment.PATH ?? ''}`;
  process.env[TIM_CODEX_APP_SERVER_SOCKET] = path.join(fixture.rootDir, 'inherited.sock');
  process.env.PERSISTENT_CODEX_SERVER_PATH = fixture.serverPath;
  process.env.PERSISTENT_CODEX_SPAWN_LOG = fixture.spawnLogPath;
  process.env.PERSISTENT_CODEX_REQUEST_LOG = fixture.requestLogPath;
}

function restoreEnvironment(): void {
  restoreEnvironmentValue('PATH', originalEnvironment.PATH);
  restoreEnvironmentValue(TIM_CODEX_APP_SERVER_SOCKET, originalEnvironment.socket);
  restoreEnvironmentValue('PERSISTENT_CODEX_SERVER_PATH', originalEnvironment.serverPath);
  restoreEnvironmentValue('PERSISTENT_CODEX_SPAWN_LOG', originalEnvironment.spawnLog);
  restoreEnvironmentValue('PERSISTENT_CODEX_REQUEST_LOG', originalEnvironment.requestLog);
}

function restoreEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitForState(
  manager: AgentManager,
  agentId: string,
  state: 'running-active' | 'running-idle'
): Promise<void> {
  await vi.waitFor(() => {
    expect(manager.getAgentSnapshot(agentId)?.state).toBe(state);
  });
}

describe('production Codex AgentManager transport integration', () => {
  it('keeps two private agents isolated across active, idle, graceful, and forced turns', async () => {
    const fixture = await createFixture();
    const { owner, registry, rootProcessId } = createOwner();
    let manager: AgentManager | undefined;
    try {
      setFixtureEnvironment(fixture);
      expect(await fs.stat(fixture.codexPath)).toMatchObject({ mode: expect.any(Number) });
      const rootInput = new FakeAgentInputAdapter();
      rootInput.markReady();
      let managerForDispatcher: AgentManager | undefined;
      const dispatcher = {
        startAgent: (caller: Parameters<AgentManager['startAgent']>[0], request: unknown) =>
          managerForDispatcher!.startAgent(caller, request),
        listAgents: () => managerForDispatcher!.listAgents(),
        sendAgentMessage: (
          caller: Parameters<AgentManager['sendAgentMessage']>[0],
          request: unknown
        ) => managerForDispatcher!.sendAgentMessage(caller, request),
        stopAgent: (caller: Parameters<AgentManager['stopAgent']>[0], request: unknown) =>
          managerForDispatcher!.stopAgent(caller, request),
        finishAgent: (caller: Parameters<AgentManager['finishAgent']>[0], request: unknown) =>
          managerForDispatcher!.finishAgent(caller, request),
      };
      const launcher = createCodexAgentLauncher({
        dispatcher,
        sessionProcessOwner: owner,
        messagingDirectory: '/tmp/tim-agent-production-session',
      });
      let nextId = 0;
      manager = await createAgentManager({
        orchestratorExecutor: 'codex-cli',
        agentPreparer: createPreparation(fixture.rootDir),
        agentLauncher: launcher,
        agentIdGenerator: () => `real-codex-agent-${++nextId}`,
        orchestratorInputAdapter: rootInput,
      });
      managerForDispatcher = manager;
      const root = { id: manager.orchestratorIdentity.id, role: 'orchestrator' as const };

      const first = await runWithSessionProcessOwner(owner, () =>
        manager!.startAgent(root, {
          name: 'real-first',
          type: 'implementer',
          executor: 'codex-cli',
          initialMessage: 'Start the first assignment.',
        })
      );
      const second = await runWithSessionProcessOwner(owner, () =>
        manager!.startAgent(root, {
          name: 'real-second',
          type: 'tester',
          executor: 'codex-cli',
          initialMessage: 'Start the second assignment.',
        })
      );

      expect(first.state).toBe('running-active');
      expect(second.state).toBe('running-active');
      const runningExecutors = registry
        .getSnapshot()
        .filter((node) => node.kind === 'executor' && node.state === 'running');
      expect(runningExecutors).toHaveLength(4);
      expect(runningExecutors.every((node) => node.parentProcessId === rootProcessId)).toBe(true);
      expect(runningExecutors.map((node) => node.label).sort()).toEqual([
        'Codex app-server (real-first)',
        'Codex app-server (real-second)',
        'Codex thread (real-first)',
        'Codex thread (real-second)',
      ]);
      expect(
        new Set([
          manager.getAgentSnapshot(first.id)?.providerThreadId,
          manager.getAgentSnapshot(second.id)?.providerThreadId,
        ]).size
      ).toBe(2);

      await expect(
        manager.sendAgentMessage(root, {
          name: 'real-first',
          message: 'Steer the first assignment.',
        })
      ).resolves.toMatchObject({ delivery: 'steered' });
      await waitForState(manager, first.id, 'running-idle');

      await expect(
        manager.stopAgent(root, {
          name: 'real-second',
          message: 'Provide the final status for the second assignment.',
        })
      ).resolves.toMatchObject({ mode: 'graceful-requested', state: 'stopping' });
      await manager.waitForAgentTerminal(second.id);

      await expect(
        manager.sendAgentMessage(root, {
          name: 'real-first',
          message: 'Continue the first assignment while idle.',
        })
      ).resolves.toMatchObject({ delivery: 'started-idle-turn' });
      await waitForState(manager, first.id, 'running-idle');

      await expect(
        manager.stopAgent(root, { name: 'real-first', force: true })
      ).resolves.toMatchObject({ mode: 'forced', state: 'stopping' });
      await manager.waitForAgentTerminal(first.id);

      expect(manager.listAgents().agents).toHaveLength(1);
      expect(rootInput.receivedMessages).toHaveLength(2);
      expect(rootInput.receivedMessages.map((message) => message.content).join('\n')).toContain(
        'stale or out of context'
      );
      expect(
        registry
          .getSnapshot()
          .filter((node) => node.label.includes('real-'))
          .every((node) => node.state === 'exited')
      ).toBe(true);

      const spawnLog = await fs.readFile(fixture.spawnLogPath, 'utf8');
      const privateSocketLines = spawnLog
        .split('\n')
        .filter((line) => line.startsWith(`${TIM_CODEX_APP_SERVER_SOCKET}=`));
      expect(privateSocketLines).toHaveLength(2);
      expect(new Set(privateSocketLines).size).toBe(2);
      expect(privateSocketLines.every((line) => !line.includes('inherited.sock'))).toBe(true);

      const requestLines = (await fs.readFile(fixture.requestLogPath, 'utf8'))
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
      expect(requestLines.filter((request) => request.method === 'thread/start')).toHaveLength(2);
      expect(
        requestLines.filter((request) => request.method === 'turn/steer').length
      ).toBeGreaterThanOrEqual(2);
      expect(
        requestLines.filter((request) => request.method === 'turn/start').length
      ).toBeGreaterThanOrEqual(3);
    } finally {
      await manager?.close().catch(() => undefined);
      owner.dispose();
      restoreEnvironment();
      await fs.rm(fixture.rootDir, { recursive: true, force: true });
    }
  });
});
