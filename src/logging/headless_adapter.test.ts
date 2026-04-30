import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HeadlessAdapter } from './headless_adapter.ts';
import type { HeadlessMessage, HeadlessServerMessage } from './headless_protocol.ts';
import { createRecordingAdapter } from './test_helpers.ts';
import { readSessionInfoFile } from '../tim/session_server/runtime_dir.ts';

function parseMessage(
  message: string | Buffer | ArrayBuffer | ArrayBufferView
): HeadlessMessage | null {
  const text =
    typeof message === 'string'
      ? message
      : message instanceof Buffer
        ? message.toString('utf8')
        : ArrayBuffer.isView(message)
          ? Buffer.from(message.buffer, message.byteOffset, message.byteLength).toString('utf8')
          : Buffer.from(message).toString('utf8');

  try {
    return JSON.parse(text) as HeadlessMessage;
  } catch {
    return null;
  }
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

function createTestHeadlessAdapter(
  sessionInfo: ConstructorParameters<typeof HeadlessAdapter>[0],
  wrappedAdapter: ConstructorParameters<typeof HeadlessAdapter>[1],
  options?: ConstructorParameters<typeof HeadlessAdapter>[2]
): HeadlessAdapter {
  return new HeadlessAdapter(sessionInfo, wrappedAdapter, {
    serverPort: 0,
    serverHostname: '127.0.0.1',
    ...options,
  });
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempCacheDir = '';

beforeEach(async () => {
  tempCacheDir = await mkdtemp(path.join(os.tmpdir(), 'tim-headless-adapter-test-'));
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

describe('HeadlessAdapter', () => {
  it('buffers output in replay history and forwards local output', async () => {
    const { adapter: wrapped, calls } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);

    adapter.log('hello');
    adapter.writeStdout('world\n');
    adapter.warn('warning');

    expect(calls.map((call) => call.method)).toEqual(['log', 'writeStdout', 'warn']);
    const internals = adapter as any;
    expect(internals.history).toHaveLength(3);
    expect(internals.historyOutputBytes).toBeGreaterThan(0);

    await adapter.destroy();
  });

  it('drops non-serializable structured messages without throwing', async () => {
    const { adapter: wrapped, calls } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);

    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() =>
      adapter.sendStructured({
        type: 'llm_tool_use',
        timestamp: '2026-02-08T00:00:00.000Z',
        toolName: 'Write',
        input: circular,
      })
    ).not.toThrow();

    expect((adapter as any).history).toHaveLength(0);
    expect(calls.at(-1)).toEqual({
      method: 'error',
      args: ['Failed to serialize headless tunnel message:', expect.any(Error)],
    });

    await adapter.destroy();
  });

  it('replays history to embedded-server clients with session info and replay markers', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter(
      {
        command: 'agent',
        interactive: false,
        planId: 166,
        planTitle: 'headless mode',
        workspacePath: '/tmp/workspace',
        gitRemote: 'git@example.com:repo.git',
      },
      wrapped
    );

    adapter.log('before-connect-1');
    adapter.log('before-connect-2');
    adapter.sendPlanContent('# latest plan');

    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const messages: HeadlessMessage[] = [];
    ws.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        messages.push(parsed);
      }
    });

    await waitFor(() => messages.some((message) => message.type === 'replay_end'));

    expect(messages[0]).toMatchObject({
      type: 'session_info',
      command: 'agent',
      planId: 166,
      planTitle: 'headless mode',
      workspacePath: '/tmp/workspace',
      gitRemote: 'git@example.com:repo.git',
      sessionId: expect.any(String),
    });
    expect(messages[1]).toEqual({ type: 'plan_content', content: '# latest plan', tasks: [] });
    expect(messages[2]).toEqual({ type: 'replay_start' });
    expect(messages[3]).toMatchObject({ type: 'output', seq: 1 });
    expect(messages[4]).toMatchObject({ type: 'output', seq: 2 });
    expect(messages[5]).toEqual({ type: 'replay_end' });

    ws.close();
    await adapter.destroy();
  });

  it('broadcasts live output and updated session info to embedded-server clients', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter(
      {
        command: 'agent',
        interactive: false,
        workspacePath: '/tmp/original',
        gitRemote: 'example.com/original',
      },
      wrapped
    );

    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const messages: HeadlessMessage[] = [];
    ws.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        messages.push(parsed);
      }
    });
    await waitFor(() => messages.some((message) => message.type === 'replay_end'));
    messages.length = 0;

    adapter.log('live-message');
    adapter.updateSessionInfo({
      workspacePath: '/tmp/updated',
      gitRemote: 'example.com/updated',
    });

    await waitFor(
      () =>
        messages.some((message) => message.type === 'output') &&
        messages.some(
          (message) => message.type === 'session_info' && message.workspacePath === '/tmp/updated'
        )
    );

    expect(messages.find((message) => message.type === 'output')).toMatchObject({
      type: 'output',
      seq: 1,
      message: { type: 'log', args: ['live-message'] },
    });
    expect(messages.find((message) => message.type === 'session_info')).toMatchObject({
      type: 'session_info',
      workspacePath: '/tmp/updated',
      gitRemote: 'example.com/updated',
      sessionId: expect.any(String),
    });

    ws.close();
    await adapter.destroy();
  });

  it('broadcasts live plan content updates to embedded-server clients', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);

    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const messages: HeadlessMessage[] = [];
    ws.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        messages.push(parsed);
      }
    });
    await waitFor(() => messages.some((message) => message.type === 'replay_end'));
    messages.length = 0;

    adapter.sendPlanContent('## updated plan');

    await waitFor(() => messages.some((message) => message.type === 'plan_content'));

    expect(messages).toContainEqual({
      type: 'plan_content',
      content: '## updated plan',
      tasks: [],
    });

    ws.close();
    await adapter.destroy();
  });

  it('replays only the latest plan content to newly connected clients', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);

    adapter.sendPlanContent('# first version');
    adapter.sendPlanContent('# second version');

    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const messages: HeadlessMessage[] = [];
    ws.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        messages.push(parsed);
      }
    });

    await waitFor(() => messages.some((message) => message.type === 'replay_end'));

    expect(messages.filter((message) => message.type === 'plan_content')).toEqual([
      {
        type: 'plan_content',
        content: '# second version',
        tasks: [],
      },
    ]);

    ws.close();
    await adapter.destroy();
  });

  it('writes session metadata including planUuid and sessionId to the session file', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter(
      {
        command: 'review',
        planId: 42,
        planUuid: 'plan-uuid-42',
        planTitle: 'review plan',
        linkedPlanId: 43,
        linkedPlanUuid: 'linked-plan-uuid-43',
        linkedPlanTitle: 'linked plan',
        linkedPrUrl: 'https://github.com/owner/repo/pull/42',
        linkedPrNumber: 42,
        linkedPrTitle: 'review target',
      },
      wrapped
    );

    const info = readSessionInfoFile(process.pid);
    expect(info).toMatchObject({
      pid: process.pid,
      command: 'review',
      hostname: '127.0.0.1',
      planId: 42,
      planUuid: 'plan-uuid-42',
      planTitle: 'review plan',
      linkedPlanId: 43,
      linkedPlanUuid: 'linked-plan-uuid-43',
      linkedPlanTitle: 'linked plan',
      linkedPrUrl: 'https://github.com/owner/repo/pull/42',
      linkedPrNumber: 42,
      linkedPrTitle: 'review target',
      sessionId: expect.any(String),
    });

    await adapter.destroy();
  });

  it('handles prompt, user input, and end-session messages from embedded-server clients', async () => {
    const { adapter: wrapped, calls } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);
    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);

    await waitFor(() => readSessionInfoFile(process.pid) != null);

    let receivedInput: string | undefined;
    let endSessionCount = 0;
    adapter.setUserInputHandler((content) => {
      receivedInput = content;
    });
    adapter.setEndSessionHandler(() => {
      endSessionCount += 1;
    });

    const prompt = adapter.waitForPromptResponse('req-1');
    ws.send(
      JSON.stringify({
        type: 'prompt_response',
        requestId: 'req-1',
        value: 'accepted',
      } satisfies HeadlessServerMessage)
    );
    await expect(prompt.promise).resolves.toBe('accepted');

    ws.send(
      JSON.stringify({ type: 'user_input', content: 'typed input' } satisfies HeadlessServerMessage)
    );
    await waitFor(() => receivedInput === 'typed input');

    ws.send(JSON.stringify({ type: 'end_session' } satisfies HeadlessServerMessage));
    await waitFor(() => endSessionCount === 1);
    ws.send(JSON.stringify({ type: 'end_session' } satisfies HeadlessServerMessage));
    await waitFor(() => endSessionCount === 2);

    expect(calls).toContainEqual({
      method: 'sendStructured',
      args: [
        {
          type: 'user_terminal_input',
          content: 'typed input',
          source: 'gui',
          timestamp: expect.any(String),
        },
      ],
    });

    ws.close();
    await adapter.destroy();
  });

  it('tracks notification subscriber updates from embedded-server clients', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);
    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);

    expect(adapter.hasNotificationSubscribers()).toBe(false);

    ws.send(
      JSON.stringify({
        type: 'notification_subscribers_changed',
        hasSubscribers: true,
      } satisfies HeadlessServerMessage)
    );
    await waitFor(() => adapter.hasNotificationSubscribers());

    ws.send(
      JSON.stringify({
        type: 'notification_subscribers_changed',
        hasSubscribers: false,
      } satisfies HeadlessServerMessage)
    );
    await waitFor(() => !adapter.hasNotificationSubscribers());

    ws.close();
    await adapter.destroy();
  });

  it('resets notification subscribers when all clients disconnect', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);
    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);

    ws.send(
      JSON.stringify({
        type: 'notification_subscribers_changed',
        hasSubscribers: true,
      } satisfies HeadlessServerMessage)
    );
    await waitFor(() => adapter.hasNotificationSubscribers());

    // Disconnect without sending hasSubscribers: false
    ws.close();
    await waitFor(() => !adapter.hasNotificationSubscribers());

    await adapter.destroy();
  });

  it('honors maxBufferBytes by trimming replay history', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped, {
      maxBufferBytes: 250,
    });

    for (let index = 0; index < 20; index += 1) {
      adapter.log(`line-${index}`);
    }

    const internals = adapter as any;
    expect(internals.historyOutputBytes).toBeLessThanOrEqual(250);
    expect(internals.history.length).toBeLessThan(20);

    await adapter.destroy();
  });
});
