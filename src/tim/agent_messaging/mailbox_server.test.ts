import { Buffer } from 'node:buffer';
import { promises as fs } from 'node:fs';
import net from 'node:net';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { MailboxJsonlDecoder } from './mailbox_framing.js';
import {
  MAX_PENDING_MESSAGES_PER_RECIPIENT,
  MAX_MAILBOX_FRAME_BYTES,
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
import {
  createMailboxReceiver,
  type MailboxReceiver,
  type MailboxSourceRegistrationResolver,
} from './mailbox_server.js';

interface TestMailbox {
  readonly runtime: AgentMessagingRuntimeDirectory;
  readonly source: AgentRegistration;
  readonly target: AgentRegistration;
  readonly receiver: MailboxReceiver;
}

const receivers: MailboxReceiver[] = [];
const runtimes: AgentMessagingRuntimeDirectory[] = [];

interface CreateMailboxOptions {
  readonly maxConnections?: number;
  readonly recentRequestIdLimit?: number;
  readonly resolveSourceRegistration?: MailboxSourceRegistrationResolver;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

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
  options: CreateMailboxOptions = {}
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
  const resolveSourceRegistration =
    options.resolveSourceRegistration ??
    ((sourceId: string, sourceName: string): AgentRegistration | undefined => {
      const registration = active.get(sourceId);
      return registration?.name === sourceName ? registration : undefined;
    });
  const receiver = await createMailboxReceiver({
    runtime,
    registration: target,
    resolveSourceRegistration,
    deliver,
    maxConnections: options.maxConnections,
    recentRequestIdLimit: options.recentRequestIdLimit,
  });
  receivers.push(receiver);
  return { runtime, source, target, receiver };
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function connectSocket(socketPath: string): Promise<net.Socket> {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function waitForSocketClose(socket: net.Socket): Promise<void> {
  if (socket.destroyed) {
    return;
  }
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.once('error', () => resolve());
  });
}

async function sendAndEnd(
  socketPath: string,
  bytes: Uint8Array,
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
      socket.end(bytes);
    });
    socket.on('data', (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const frame = parseMailboxFrame(line);
        if (frame.kind === 'ack') {
          acknowledgement = frame;
        }
      }
    });
    socket.on('error', (error: Error) => {
      if (!connected) {
        clearTimeout(timer);
        reject(error);
      }
    });
    socket.on('end', finish);
    socket.on('close', finish);
  });
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
    socket.on('end', finish);
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

  test('rejects a pre-existing socket entry before attempting to bind', async () => {
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
    await fs.writeFile(target.socketPath, 'not a socket');

    await expect(
      createMailboxReceiver({
        runtime,
        registration: target,
        resolveSourceRegistration: (): undefined => undefined,
        deliver: (): 'steered' => 'steered',
      })
    ).rejects.toMatchObject({ code: 'unexpected_path_entry' });
    expect((await fs.lstat(target.socketPath)).isFile()).toBe(true);
  });

  test('fails cleanly when the socket path is occupied after validation but before bind', async () => {
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
    const blocker = net.createServer();
    const originalLstat = fs.lstat.bind(fs);
    let missingSocketChecks = 0;
    let blockerStarted = false;
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      try {
        return await originalLstat(...args);
      } catch (error) {
        if (String(args[0]) === target.socketPath) {
          missingSocketChecks += 1;
          if (missingSocketChecks === 3) {
            await new Promise<void>((resolve, reject) => {
              blocker.once('error', reject);
              blocker.listen(target.socketPath, resolve);
            });
            blockerStarted = true;
          }
        }
        throw error;
      }
    });

    try {
      await expect(
        createMailboxReceiver({
          runtime,
          registration: target,
          resolveSourceRegistration: (): undefined => undefined,
          deliver: (): 'steered' => 'steered',
        })
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      lstatSpy.mockRestore();
      if (blockerStarted) {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    }

    await expect(fs.lstat(target.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rolls back the listening socket when post-listen path verification fails', async () => {
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
    const validateSocketPath = runtime.validateSocketPath.bind(runtime);
    let validationCalls = 0;
    vi.spyOn(runtime, 'validateSocketPath').mockImplementation(async (socketPath, options) => {
      await validateSocketPath(socketPath, options);
      validationCalls += 1;
      if (validationCalls === 2) {
        throw new Error('simulated post-listen path verification failure');
      }
    });

    await expect(
      createMailboxReceiver({
        runtime,
        registration: target,
        resolveSourceRegistration: (): undefined => undefined,
        deliver: (): 'steered' => 'steered',
      })
    ).rejects.toThrow('simulated post-listen path verification failure');
    expect(validationCalls).toBe(2);
    await expect(fs.lstat(target.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    vi.restoreAllMocks();
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

  test('maps source resolver throws, malformed records, and identity mismatches to unknown_source', async () => {
    const resolverMode = { value: 'throws' as 'throws' | 'malformed' | 'mismatch' };
    let callbackCount = 0;
    let mailboxSource: AgentRegistration | undefined;
    const mailbox = await createMailbox(
      (): 'steered' => {
        callbackCount += 1;
        return 'steered';
      },
      {
        resolveSourceRegistration: async (): Promise<AgentRegistration | undefined> => {
          if (resolverMode.value === 'throws') {
            throw new Error('resolver failed');
          }
          if (resolverMode.value === 'malformed') {
            return { id: 'source-id', name: 'orchestrator' } as AgentRegistration;
          }
          return mailboxSource;
        },
      }
    );
    mailboxSource = mailbox.target;

    const throwsAcknowledgement = await sendRequest(
      mailbox,
      requestFor(mailbox, 'resolver-throws', 'message')
    );
    expect(throwsAcknowledgement).toMatchObject({
      requestId: 'resolver-throws',
      success: false,
      error: { code: 'unknown_source' },
    });

    resolverMode.value = 'malformed';
    const malformedAcknowledgement = await sendRequest(
      mailbox,
      requestFor(mailbox, 'resolver-malformed', 'message')
    );
    expect(malformedAcknowledgement).toMatchObject({
      requestId: 'resolver-malformed',
      success: false,
      error: { code: 'unknown_source' },
    });

    resolverMode.value = 'mismatch';
    const mismatchAcknowledgement = await sendRequest(
      mailbox,
      requestFor(mailbox, 'resolver-mismatch', 'message')
    );
    expect(mismatchAcknowledgement).toMatchObject({
      requestId: 'resolver-mismatch',
      success: false,
      error: { code: 'unknown_source' },
    });
    expect(callbackCount).toBe(0);
  });

  test('does not mutate the queue when delivery throws or returns an invalid result', async () => {
    const mode = { value: 'throws' as 'throws' | 'invalid' };
    const mailbox = await createMailbox((): 'steered' => {
      if (mode.value === 'throws') {
        throw new Error('delivery failed');
      }
      return 'not-a-delivery-result' as never;
    });

    const thrownAcknowledgement = await sendRequest(
      mailbox,
      requestFor(mailbox, 'callback-throws', 'message')
    );
    expect(thrownAcknowledgement).toMatchObject({
      requestId: 'callback-throws',
      success: false,
      error: { code: 'connection_failed' },
    });
    expect(mailbox.receiver.pendingCount).toBe(0);

    mode.value = 'invalid';
    const invalidAcknowledgement = await sendRequest(
      mailbox,
      requestFor(mailbox, 'callback-invalid', 'message')
    );
    expect(invalidAcknowledgement).toMatchObject({
      requestId: 'callback-invalid',
      success: false,
      error: { code: 'connection_failed' },
    });
    expect(mailbox.receiver.pendingCount).toBe(0);
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

  test('enforces the 100/101 queue boundary under concurrent senders', async () => {
    const mailbox = await createMailbox(
      (): 'temporarily-unavailable' => 'temporarily-unavailable',
      { maxConnections: 128, recentRequestIdLimit: 128 }
    );
    const acknowledgements = await Promise.all(
      Array.from({ length: MAX_PENDING_MESSAGES_PER_RECIPIENT + 1 }, (_, index) =>
        sendRequest(mailbox, requestFor(mailbox, `concurrent-queue-${index}`, `message-${index}`))
      )
    );

    const successful = acknowledgements.filter(
      (acknowledgement) => acknowledgement.success && acknowledgement.delivery === 'queued'
    );
    const full = acknowledgements.filter(
      (acknowledgement) => !acknowledgement.success && acknowledgement.error.code === 'queue_full'
    );
    expect(successful).toHaveLength(MAX_PENDING_MESSAGES_PER_RECIPIENT);
    expect(full).toHaveLength(1);
    expect(mailbox.receiver.pendingCount).toBe(MAX_PENDING_MESSAGES_PER_RECIPIENT);
    expect(
      mailbox.receiver
        .drainPending()
        .map((entry) => entry.request.content)
        .sort()
    ).toEqual(
      Array.from(
        { length: MAX_PENDING_MESSAGES_PER_RECIPIENT },
        (_, index) => `message-${index}`
      ).sort()
    );
  });

  test('honors drain limits and leaves messages arriving after a drain behind the returned batch', async () => {
    const mailbox = await createMailbox((): 'temporarily-unavailable' => 'temporarily-unavailable');
    for (let index = 1; index <= 3; index += 1) {
      await sendRequest(mailbox, requestFor(mailbox, `drain-${index}`, `message-${index}`));
    }

    expect(mailbox.receiver.drainPending(0)).toEqual([]);
    const first = mailbox.receiver.drainPending(2);
    expect(first.map((entry) => entry.request.content)).toEqual(['message-1', 'message-2']);
    await sendRequest(mailbox, requestFor(mailbox, 'drain-4', 'message-4'));
    expect(mailbox.receiver.drainPending(99).map((entry) => entry.request.content)).toEqual([
      'message-3',
      'message-4',
    ]);
    expect(mailbox.receiver.drainPending()).toEqual([]);
    expect(() => mailbox.receiver.drainPending(-1)).toThrow(RangeError);
    expect(() => mailbox.receiver.drainPending(Number.NaN)).toThrow(RangeError);
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

  test('replays the same fingerprint while delivery is in flight and rejects a conflicting one', async () => {
    const deliveryStarted = deferred<void>();
    const releaseDelivery = deferred<void>();
    let deliveryCount = 0;
    const mailbox = await createMailbox(
      async (): Promise<'steered'> => {
        deliveryCount += 1;
        deliveryStarted.resolve();
        await releaseDelivery.promise;
        return 'steered';
      },
      { maxConnections: 4, recentRequestIdLimit: 4 }
    );
    const request = requestFor(mailbox, 'in-flight-duplicate', 'original');
    const firstPromise = sendRequest(mailbox, request);
    await deliveryStarted.promise;
    const replayPromise = sendRequest(mailbox, request);
    const conflictingPromise = sendRequest(
      mailbox,
      requestFor(mailbox, 'in-flight-duplicate', 'different')
    );

    await Promise.resolve();
    expect(deliveryCount).toBe(1);
    releaseDelivery.resolve();
    const [first, replay, conflicting] = await Promise.all([
      firstPromise,
      replayPromise,
      conflictingPromise,
    ]);
    expect(replay).toEqual(first);
    expect(conflicting).toMatchObject({
      requestId: 'in-flight-duplicate',
      success: false,
      error: { code: 'duplicate_message_id' },
    });
    expect(deliveryCount).toBe(1);
  });

  test('evicts completed request IDs at the configured bound', async () => {
    let deliveryCount = 0;
    const mailbox = await createMailbox(
      (): 'steered' => {
        deliveryCount += 1;
        return 'steered';
      },
      { maxConnections: 1, recentRequestIdLimit: 2 }
    );

    await sendRequest(mailbox, requestFor(mailbox, 'evict-1', 'message-1'));
    await sendRequest(mailbox, requestFor(mailbox, 'evict-2', 'message-2'));
    await sendRequest(mailbox, requestFor(mailbox, 'evict-3', 'message-3'));
    const replayAfterEviction = await sendRequest(
      mailbox,
      requestFor(mailbox, 'evict-1', 'message-1')
    );

    expect(replayAfterEviction).toMatchObject({
      requestId: 'evict-1',
      success: true,
      delivery: 'steered',
    });
    expect(deliveryCount).toBe(4);
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

  test('rejects connections over the configured limit and recovers after a client closes', async () => {
    let deliveryCount = 0;
    const mailbox = await createMailbox(
      (): 'steered' => {
        deliveryCount += 1;
        return 'steered';
      },
      { maxConnections: 1, recentRequestIdLimit: 1 }
    );
    const first = await connectSocket(mailbox.receiver.socketPath);
    const second = net.createConnection(mailbox.receiver.socketPath);
    await waitForSocketClose(second).catch(() => undefined);
    first.destroy();
    await waitForSocketClose(first);

    const acknowledgement = await sendRequest(
      mailbox,
      requestFor(mailbox, 'after-connection-limit', 'healthy')
    );
    expect(acknowledgement).toMatchObject({
      requestId: 'after-connection-limit',
      success: true,
      delivery: 'steered',
    });
    expect(deliveryCount).toBe(1);
  });

  test('rejects oversized, incomplete, and invalid frames without harming healthy clients', async () => {
    const delivered: string[] = [];
    const mailbox = await createMailbox((request: MailboxMessageRequest): 'steered' => {
      delivered.push(request.content);
      return 'steered';
    });
    const oversized = Buffer.from(
      `${JSON.stringify({
        protocolVersion: 1,
        kind: 'message',
        requestId: 'oversized',
        sourceId: mailbox.source.id,
        sourceName: mailbox.source.name,
        targetId: mailbox.target.id,
        targetName: mailbox.target.name,
        content: 'x'.repeat(MAX_MAILBOX_FRAME_BYTES),
        timestamp: '2026-08-12T00:00:00.000Z',
      })}\n`,
      'utf8'
    );
    expect(oversized.byteLength).toBeGreaterThan(MAX_MAILBOX_FRAME_BYTES);
    expect(await sendRaw(mailbox.receiver.socketPath, [oversized])).toBeUndefined();

    const incompleteRequest = requestFor(mailbox, 'incomplete', 'unfinished');
    expect(
      await sendAndEnd(
        mailbox.receiver.socketPath,
        Buffer.from(encodeMailboxFrame(incompleteRequest).slice(0, -1), 'utf8')
      )
    ).toBeUndefined();

    const unsupportedVersion = Buffer.from(
      `${JSON.stringify({
        protocolVersion: 999,
        kind: 'message',
        requestId: 'unsupported-version',
        sourceId: mailbox.source.id,
        sourceName: mailbox.source.name,
        targetId: mailbox.target.id,
        targetName: mailbox.target.name,
        content: 'invalid version',
        timestamp: '2026-08-12T00:00:00.000Z',
      })}\n`,
      'utf8'
    );
    const unsupportedAcknowledgement = await sendRaw(mailbox.receiver.socketPath, [
      unsupportedVersion,
    ]);
    expect(unsupportedAcknowledgement).toMatchObject({
      requestId: 'unsupported-version',
      success: false,
      error: { code: 'unsupported_version' },
    });

    const healthyAcknowledgement = await sendRequest(
      mailbox,
      requestFor(mailbox, 'after-invalid-frames', 'healthy')
    );
    expect(healthyAcknowledgement).toMatchObject({
      requestId: 'after-invalid-frames',
      success: true,
    });
    expect(delivered).toEqual(['healthy']);
  });

  test('does not invoke delivery or enqueue after close wins a resolver race', async () => {
    const resolverStarted = deferred<void>();
    const releaseResolver = deferred<void>();
    let callbackCount = 0;
    let sourceRegistration: AgentRegistration | undefined;
    const mailbox = await createMailbox(
      (): 'steered' => {
        callbackCount += 1;
        return 'steered';
      },
      {
        resolveSourceRegistration: async (): Promise<AgentRegistration | undefined> => {
          resolverStarted.resolve();
          await releaseResolver.promise;
          return sourceRegistration;
        },
      }
    );
    sourceRegistration = mailbox.source;
    const requestPromise = sendRaw(mailbox.receiver.socketPath, [
      Buffer.from(encodeMailboxFrame(requestFor(mailbox, 'resolver-close', 'message')), 'utf8'),
    ]);
    await resolverStarted.promise;
    await mailbox.receiver.close();
    releaseResolver.resolve();

    expect(await requestPromise).toBeUndefined();
    expect(callbackCount).toBe(0);
    expect(mailbox.receiver.pendingCount).toBe(0);
  });

  test('settles a callback race without queue mutation or duplicate callback invocation', async () => {
    const callbackStarted = deferred<void>();
    const releaseCallback = deferred<void>();
    let callbackCount = 0;
    const mailbox = await createMailbox(async (): Promise<'temporarily-unavailable'> => {
      callbackCount += 1;
      callbackStarted.resolve();
      await releaseCallback.promise;
      return 'temporarily-unavailable';
    });
    const requestPromise = sendRaw(mailbox.receiver.socketPath, [
      Buffer.from(encodeMailboxFrame(requestFor(mailbox, 'callback-close', 'message')), 'utf8'),
    ]);
    await callbackStarted.promise;
    await mailbox.receiver.close();
    releaseCallback.resolve();

    expect(await requestPromise).toBeUndefined();
    expect(callbackCount).toBe(1);
    expect(mailbox.receiver.pendingCount).toBe(0);
  });

  test('allows the acknowledgement write race to finish without leaking the socket', async () => {
    const acknowledgementReady = deferred<void>();
    const mailbox = await createMailbox((): 'steered' => {
      acknowledgementReady.resolve();
      return 'steered';
    });
    const requestPromise = sendRaw(mailbox.receiver.socketPath, [
      Buffer.from(encodeMailboxFrame(requestFor(mailbox, 'ack-close', 'message')), 'utf8'),
    ]);
    await acknowledgementReady.promise;
    await mailbox.receiver.close();

    expect(await requestPromise).toBeUndefined();
    await expect(fs.lstat(mailbox.receiver.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
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
