import { Buffer } from 'node:buffer';
import { promises as fs } from 'node:fs';
import net from 'node:net';

import { afterEach, describe, expect, test } from 'vitest';

import { MailboxJsonlDecoder } from './mailbox_framing.js';
import {
  MAX_PENDING_MESSAGES_PER_RECIPIENT,
  buildMailboxMessageRequest,
  encodeMailboxFrame,
  parseMailboxFrame,
  parseMailboxMessageRequest,
  type MailboxAcknowledgement,
  type MailboxMessageRequest,
} from './mailbox_protocol.js';
import {
  createAgentMessagingRuntimeDirectory,
  type AgentMessagingRuntimeDirectory,
  type AgentRegistration,
} from './runtime_dir.js';
import { createMailboxReceiver, type MailboxReceiver } from './mailbox_server.js';

interface TestMailbox {
  readonly runtime: AgentMessagingRuntimeDirectory;
  readonly source: AgentRegistration;
  readonly target: AgentRegistration;
  readonly receiver: MailboxReceiver;
}

const receivers: MailboxReceiver[] = [];
const runtimes: AgentMessagingRuntimeDirectory[] = [];

afterEach(async () => {
  await Promise.all(
    receivers.splice(0).map(async (receiver) => {
      await receiver.close().catch(() => undefined);
    })
  );
  await Promise.all(
    runtimes.splice(0).map(async (runtime) => {
      await runtime.close().catch(() => undefined);
    })
  );
});

async function createMailbox(
  deliver: Parameters<typeof createMailboxReceiver>[0]['deliver'],
  options: { maxConnections?: number; recentRequestIdLimit?: number } = {}
): Promise<TestMailbox> {
  const runtime = await createAgentMessagingRuntimeDirectory();
  runtimes.push(runtime);

  const source = runtime.createRegistration({
    id: 'source-id',
    name: 'orchestrator',
    role: 'orchestrator',
    executor: 'codex-cli',
    state: 'running-idle',
  });
  const target = runtime.createRegistration({
    id: 'target-id',
    name: 'worker-one',
    role: 'subagent',
    type: 'tester',
    executor: 'codex-cli',
    state: 'running-idle',
  });
  const active = new Map<string, AgentRegistration>([
    [source.id, source],
    [target.id, target],
  ]);
  const receiver = await createMailboxReceiver({
    runtime,
    registration: target,
    resolveSourceRegistration: (
      sourceId: string,
      sourceName: string
    ): AgentRegistration | undefined => {
      const registration = active.get(sourceId);
      return registration?.name === sourceName ? registration : undefined;
    },
    deliver,
    ...options,
  });
  receivers.push(receiver);
  return { runtime, source, target, receiver };
}

function requestFor(
  mailbox: TestMailbox,
  requestId: string,
  content: string,
  overrides: Partial<MailboxMessageRequest> = {}
): MailboxMessageRequest {
  const request = buildMailboxMessageRequest(
    { id: mailbox.source.id, name: mailbox.source.name },
    {
      requestId,
      targetId: mailbox.target.id,
      targetName: mailbox.target.name,
      content,
      timestamp: '2026-08-12T00:00:00.000Z',
    }
  );
  return parseMailboxMessageRequest({ ...request, ...overrides });
}

async function sendRaw(
  socketPath: string,
  chunks: readonly Uint8Array[],
  timeoutMs: number = 5_000
): Promise<MailboxAcknowledgement | undefined> {
  return new Promise<MailboxAcknowledgement | undefined>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const decoder = new MailboxJsonlDecoder();
    let acknowledgement: MailboxAcknowledgement | undefined;
    let connected = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Mailbox test client timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (): void => {
      clearTimeout(timer);
      resolve(acknowledgement);
    };
    socket.on('connect', () => {
      connected = true;
      void (async (): Promise<void> => {
        for (const chunk of chunks) {
          if (!socket.destroyed) {
            socket.write(chunk);
          }
          await new Promise<void>((resolveNext) => setImmediate(resolveNext));
        }
        // The sender keeps the connection open while it waits for the ack.
      })().catch((error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    socket.on('data', (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        if (acknowledgement !== undefined) {
          continue;
        }
        const frame = parseMailboxFrame(line);
        if (frame.kind !== 'ack') {
          clearTimeout(timer);
          reject(new Error('Mailbox test client received a non-ack frame'));
          socket.destroy();
          return;
        }
        acknowledgement = frame;
        socket.destroy();
      }
    });
    socket.on('error', (error: Error) => {
      if (!connected) {
        clearTimeout(timer);
        reject(error);
      }
    });
    socket.on('close', finish);
  });
}

async function sendRequest(
  mailbox: TestMailbox,
  request: MailboxMessageRequest,
  splitAt?: number
): Promise<MailboxAcknowledgement> {
  const encoded = Buffer.from(encodeMailboxFrame(request), 'utf8');
  const chunks =
    splitAt === undefined ? [encoded] : [encoded.subarray(0, splitAt), encoded.subarray(splitAt)];
  const acknowledgement = await sendRaw(mailbox.receiver.socketPath, chunks);
  expect(acknowledgement).toBeDefined();
  return acknowledgement as MailboxAcknowledgement;
}

describe('agent mailbox receiver', () => {
  test('validates receiver options before allocating a socket', async () => {
    const runtime = await createAgentMessagingRuntimeDirectory();
    runtimes.push(runtime);
    const target = runtime.createRegistration({
      id: 'target-id',
      name: 'worker-one',
      role: 'subagent',
      type: 'tester',
      executor: 'codex-cli',
      state: 'running-idle',
    });

    await expect(
      createMailboxReceiver({
        runtime,
        registration: target,
        resolveSourceRegistration: (): undefined => undefined,
        deliver: (): 'steered' => 'steered',
        maxConnections: 0,
      })
    ).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(fs.lstat(target.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('waits for the socket to listen and reports immediate dispositions', async () => {
    const delivered: MailboxMessageRequest[] = [];
    const mailbox = await createMailbox(
      (request: MailboxMessageRequest): 'steered' | 'started-idle-turn' => {
        delivered.push(request);
        return request.content === 'idle' ? 'started-idle-turn' : 'steered';
      }
    );

    expect(mailbox.receiver.isClosed).toBe(false);
    expect((await fs.lstat(mailbox.receiver.socketPath)).isSocket()).toBe(true);

    const steered = await sendRequest(mailbox, requestFor(mailbox, 'request-steered', 'active'));
    const idle = await sendRequest(mailbox, requestFor(mailbox, 'request-idle', 'idle'));

    expect(steered).toMatchObject({
      requestId: 'request-steered',
      success: true,
      delivery: 'steered',
    });
    expect(idle).toMatchObject({
      requestId: 'request-idle',
      success: true,
      delivery: 'started-idle-turn',
    });
    expect(delivered.map((request) => request.content)).toEqual(['active', 'idle']);
  });

  test('requires an active source identity and an exact receiver target', async () => {
    const delivered: MailboxMessageRequest[] = [];
    const mailbox = await createMailbox((request: MailboxMessageRequest): 'steered' => {
      delivered.push(request);
      return 'steered';
    });

    const unknownSource = requestFor(mailbox, 'unknown-source', 'message', {
      sourceId: 'unknown-id',
      sourceName: 'unknown-agent',
    });
    const unknownSourceAck = await sendRequest(mailbox, unknownSource);
    expect(unknownSourceAck).toMatchObject({
      requestId: 'unknown-source',
      success: false,
      error: { code: 'unknown_source' },
    });

    const wrongTarget = requestFor(mailbox, 'wrong-target', 'message', {
      targetId: 'other-target',
      targetName: 'other-agent',
    });
    const wrongTargetAck = await sendRequest(mailbox, wrongTarget);
    expect(wrongTargetAck).toMatchObject({
      requestId: 'wrong-target',
      success: false,
      error: { code: 'target_stale' },
    });
    expect(delivered).toHaveLength(0);
  });

  test('reconstructs split UTF-8 requests and returns validation failures with a recoverable ID', async () => {
    const delivered: MailboxMessageRequest[] = [];
    const mailbox = await createMailbox((request: MailboxMessageRequest): 'steered' => {
      delivered.push(request);
      return 'steered';
    });
    const request = requestFor(mailbox, 'split-request', 'split 🚀 message');
    const encoded = Buffer.from(encodeMailboxFrame(request), 'utf8');
    const emojiOffset = encoded.indexOf(Buffer.from('🚀', 'utf8'));
    const acknowledgement = await sendRequest(mailbox, request, emojiOffset + 1);

    expect(acknowledgement).toMatchObject({ requestId: 'split-request', success: true });
    expect(delivered[0]?.content).toBe('split 🚀 message');

    const malformed = Buffer.from(
      JSON.stringify({
        protocolVersion: 1,
        kind: 'message',
        requestId: 'recoverable-request',
        sourceId: mailbox.source.id,
      }) + '\n',
      'utf8'
    );
    const malformedAcknowledgement = await sendRaw(mailbox.receiver.socketPath, [malformed]);
    expect(malformedAcknowledgement).toMatchObject({
      requestId: 'recoverable-request',
      success: false,
      error: { code: 'invalid_message' },
    });
  });

  test('queues at most 100 messages, preserves FIFO order, and releases slots on drain', async () => {
    const mailbox = await createMailbox(
      (): 'temporarily-unavailable' => 'temporarily-unavailable',
      { maxConnections: 128, recentRequestIdLimit: 128 }
    );

    for (let index = 1; index <= MAX_PENDING_MESSAGES_PER_RECIPIENT; index += 1) {
      const acknowledgement = await sendRequest(
        mailbox,
        requestFor(mailbox, `request-${index}`, `message-${index}`)
      );
      expect(acknowledgement).toMatchObject({ success: true, delivery: 'queued' });
    }
    expect(mailbox.receiver.pendingCount).toBe(MAX_PENDING_MESSAGES_PER_RECIPIENT);

    const fullAcknowledgement = await sendRequest(
      mailbox,
      requestFor(mailbox, 'request-101', 'message-101')
    );
    expect(fullAcknowledgement).toMatchObject({
      requestId: 'request-101',
      success: false,
      error: { code: 'queue_full' },
    });
    expect(mailbox.receiver.pendingCount).toBe(MAX_PENDING_MESSAGES_PER_RECIPIENT);

    const firstHalf = mailbox.receiver.drainPending(50);
    expect(firstHalf.map((entry) => entry.request.content)).toEqual(
      Array.from({ length: 50 }, (_, index) => `message-${index + 1}`)
    );

    const afterDrain = await sendRequest(
      mailbox,
      requestFor(mailbox, 'request-102', 'message-102')
    );
    expect(afterDrain).toMatchObject({ success: true, delivery: 'queued' });

    const remaining = mailbox.receiver.drainPending();
    expect(remaining.map((entry) => entry.request.content)).toEqual([
      ...Array.from({ length: 50 }, (_, index) => `message-${index + 51}`),
      'message-102',
    ]);
    expect(mailbox.receiver.pendingCount).toBe(0);
  });

  test('replays duplicate acknowledgements without invoking delivery twice', async () => {
    let deliveryCount = 0;
    const mailbox = await createMailbox((request: MailboxMessageRequest): 'steered' => {
      deliveryCount += 1;
      expect(request.sourceName).toBe('orchestrator');
      return 'steered';
    });
    const request = requestFor(mailbox, 'duplicate-request', 'original');

    const first = await sendRequest(mailbox, request);
    const replay = await sendRequest(mailbox, request);
    const conflicting = await sendRequest(
      mailbox,
      requestFor(mailbox, 'duplicate-request', 'different')
    );

    expect(replay).toEqual(first);
    expect(conflicting).toMatchObject({
      requestId: 'duplicate-request',
      success: false,
      error: { code: 'duplicate_message_id' },
    });
    expect(deliveryCount).toBe(1);
  });

  test('keeps malformed clients isolated from concurrent valid clients', async () => {
    const delivered: string[] = [];
    const mailbox = await createMailbox(
      (request: MailboxMessageRequest): 'steered' => {
        delivered.push(request.content);
        return 'steered';
      },
      { maxConnections: 32, recentRequestIdLimit: 32 }
    );

    const malformed = await sendRaw(mailbox.receiver.socketPath, [
      Buffer.from('not-json\n', 'utf8'),
    ]);
    expect(malformed).toBeUndefined();

    const requests = Array.from({ length: 20 }, (_, index) =>
      sendRequest(mailbox, requestFor(mailbox, `concurrent-${index}`, `message-${index}`))
    );
    const acknowledgements = await Promise.all(requests);

    expect(acknowledgements.every((acknowledgement) => acknowledgement.success)).toBe(true);
    expect(delivered).toHaveLength(20);
  });

  test('rejects a second frame on one connection without affecting another connection', async () => {
    const delivered: string[] = [];
    const mailbox = await createMailbox((request: MailboxMessageRequest): 'steered' => {
      delivered.push(request.content);
      return 'steered';
    });
    const first = requestFor(mailbox, 'first-frame', 'first');
    const second = requestFor(mailbox, 'second-frame', 'second');
    const combined = Buffer.from(
      `${encodeMailboxFrame(first)}${encodeMailboxFrame(second)}`,
      'utf8'
    );

    const rejected = await sendRaw(mailbox.receiver.socketPath, [combined]);
    expect(rejected).toBeUndefined();

    const valid = await sendRequest(mailbox, requestFor(mailbox, 'healthy-frame', 'healthy'));
    expect(valid).toMatchObject({ requestId: 'healthy-frame', success: true });
    expect(delivered).toEqual(['healthy']);
  });

  test('close is idempotent, destroys partial clients, and unlinks only the owned socket', async () => {
    const mailbox = await createMailbox((): 'temporarily-unavailable' => 'temporarily-unavailable');
    const socket = net.createConnection(mailbox.receiver.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(Buffer.from('{"protocolVersion":1,"kind":"message"', 'utf8'));

    const firstClose = mailbox.receiver.close();
    const secondClose = mailbox.receiver.close();
    expect(secondClose).toBe(firstClose);
    await Promise.all([firstClose, secondClose]);
    socket.destroy();

    await expect(fs.lstat(mailbox.receiver.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mailbox.receiver.isClosed).toBe(true);
    expect(mailbox.receiver.drainPending()).toEqual([]);
  });
});
