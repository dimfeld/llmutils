import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runWithLogger } from '../../../logging/adapter.js';
import { HeadlessAdapter } from '../../../logging/headless_adapter.js';
import type { HeadlessServerMessage } from '../../../logging/headless_protocol.js';
import { createRecordingAdapter } from '../../../logging/test_helpers.js';
import { runWithEndSessionStop } from './command.js';
import { MultiAgentRunner, type AgentMultiPlan, type SpawnAgentFn } from './orchestrator.js';

function createPlan(planId: number, overrides: Partial<AgentMultiPlan> = {}): AgentMultiPlan {
  return {
    uuid: `plan-${planId}`,
    planId,
    title: `Plan ${planId}`,
    status: 'pending',
    taskCount: 1,
    doneTaskCount: 0,
    dependencies: [],
    ...overrides,
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number = 4000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`WebSocket error for ${url}`)), {
      once: true,
    });
  });
  return ws;
}

function createHarness(): {
  runner: MultiAgentRunner;
  spawnOrder: number[];
  detached: number[];
} {
  const plans = [createPlan(1), createPlan(2, { dependencies: ['plan-1'] })];
  const spawnOrder: number[] = [];
  const detached: number[] = [];
  const spawnAgent: SpawnAgentFn = (planId: number) => {
    spawnOrder.push(planId);
    return {
      pid: planId,
      exited: new Promise<number>(() => {}),
      detach: () => {
        detached.push(planId);
      },
    };
  };
  const runner = new MultiAgentRunner({
    plans,
    cwd: '/tmp/repo',
    spawnAgent,
    readPlan: async () => ({ status: 'pending' }),
    logger: { log: vi.fn(), error: vi.fn(), sendStructured: vi.fn() },
  });
  return { runner, spawnOrder, detached };
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempCacheDir = '';

beforeEach(async () => {
  tempCacheDir = await mkdtemp(path.join(os.tmpdir(), 'tim-agent-multi-end-session-'));
  process.env.XDG_CACHE_HOME = tempCacheDir;
});

afterEach(async () => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (tempCacheDir) {
    await rm(tempCacheDir, { recursive: true, force: true });
    tempCacheDir = '';
  }
});

describe('agent-multi end session', () => {
  test.each(['end_session', 'force_end_session'] as const)(
    '%s stops new agents and leaves running agents alive',
    async (messageType) => {
      const { adapter: wrapped } = createRecordingAdapter();
      const adapter = new HeadlessAdapter({ command: 'agent-multi', interactive: false }, wrapped, {
        serverPort: 0,
        serverHostname: '127.0.0.1',
      });
      const { runner, spawnOrder, detached } = createHarness();

      try {
        const run = runWithLogger(adapter, () => runWithEndSessionStop(runner));
        await waitFor(() => spawnOrder.length === 1);

        const port = (adapter as any).sessionServer.port as number;
        const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
        ws.send(JSON.stringify({ type: messageType } satisfies HeadlessServerMessage));

        const result = await run;
        ws.close();

        expect(result.stopped).toBe(true);
        expect(spawnOrder).toEqual([1]);
        expect(detached).toEqual([1]);
        expect(result.states.get('plan-1')?.status).toBe('running');
        expect(result.states.get('plan-2')?.status).toBe('pending');
      } finally {
        await adapter.destroy();
      }
    }
  );

  test('stops at once when the session end was requested before the run started', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = new HeadlessAdapter({ command: 'agent-multi', interactive: false }, wrapped, {
      serverPort: 0,
      serverHostname: '127.0.0.1',
    });
    const { runner, spawnOrder } = createHarness();

    try {
      const port = (adapter as any).sessionServer.port as number;
      const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
      ws.send(JSON.stringify({ type: 'end_session' } satisfies HeadlessServerMessage));
      await waitFor(() => adapter.hasSessionEndRequest);
      ws.close();

      const result = await runWithLogger(adapter, () => runWithEndSessionStop(runner));

      expect(result.stopped).toBe(true);
      expect(spawnOrder).toEqual([]);
    } finally {
      await adapter.destroy();
    }
  });

  test('runs normally without a headless adapter', async () => {
    const { runner, spawnOrder } = createHarness();
    const run = runWithEndSessionStop(runner);
    await waitFor(() => spawnOrder.length === 1);
    runner.requestStop();
    const result = await run;
    expect(result.stopped).toBe(true);
  });
});
