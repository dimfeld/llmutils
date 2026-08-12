import { Buffer } from 'node:buffer';
import { promises as fs } from 'node:fs';
import net from 'node:net';

import { afterEach, describe, expect, test } from 'vitest';

import { MailboxJsonlDecoder } from './mailbox_framing.js';
import type { MailboxDeliveryCallback } from './mailbox_server.js';
import {
  buildMailboxMessageRequest,
  encodeMailboxFrame,
  MAX_AGENT_MESSAGE_BYTES,
  MAX_MAILBOX_FRAME_BYTES,
  MAX_PENDING_MESSAGES_PER_RECIPIENT,
  MailboxProtocolError,
  parseMailboxFrame,
  type MailboxAcknowledgement,
  type MailboxMessageRequest,
} from './mailbox_protocol.js';
import {
  createAgentMessagingSessionRuntime,
  type AgentMessagingSessionRuntime,
  type SessionRegistrationHandle,
} from './session_runtime.js';
import type { AgentRegistrationDraft } from './runtime_dir.js';

const sessions: AgentMessagingSessionRuntime[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => undefined)));
});

function orchestratorDraft(id: string): AgentRegistrationDraft {
  return {
    id,
    name: 'orchestrator',
    role: 'orchestrator',
    executor: 'codex-cli',
    state: 'running-idle',
  };
}

function subagentDraft(id: string, name: string): AgentRegistrationDraft {
  return {
    id,
    name,
    role: 'subagent',
    type: 'tester',
    executor: 'codex-cli',
    state: 'running-idle',
  };
}

async function createSession(): Promise<AgentMessagingSessionRuntime> {
  const session = await createAgentMessagingSessionRuntime({
    connectionTimeoutMs: 1_000,
    acknowledgementTimeoutMs: 1_000,
  });
  sessions.push(session);
  return session;
}

async function register(
  session: AgentMessagingSessionRuntime,
  registration: AgentRegistrationDraft,
  deliver: MailboxDeliveryCallback,
  options: { maxConnections?: number; recentRequestIdLimit?: number } = {}
): Promise<SessionRegistrationHandle> {
  return session.register({ registration, deliver, ...options });
}

function identity(handle: SessionRegistrationHandle): { id: string; name: string } {
  return { id: handle.registration.id, name: handle.registration.name };
}

function target(name: string): { name: string } {
  return { name };
}

async function expectProtocolError(
  action: Promise<unknown>,
  code: MailboxProtocolError['code']
): Promise<void> {
  await expect(action).rejects.toMatchObject({
    name: 'MailboxProtocolError',
    code,
  });
}

async function sendRawChunks(
  socketPath: string,
  chunks: readonly Uint8Array[],
  timeoutMs: number = 5_000,
  closeAfterWrites: boolean = false
): Promise<MailboxAcknowledgement | undefined> {
  return new Promise<MailboxAcknowledgement | undefined>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const decoder = new MailboxJsonlDecoder();
    let acknowledgement: MailboxAcknowledgement | undefined;
    let connected = false;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`Raw mailbox client timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const settle = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(acknowledgement);
    };

    socket.once('connect', () => {
      connected = true;
      void (async (): Promise<void> => {
        try {
          for (const chunk of chunks) {
            await new Promise<void>((resolveWrite, rejectWrite) => {
              socket.write(chunk, (error?: Error) => {
                if (error !== undefined && error !== null) {
                  rejectWrite(error);
                } else {
                  resolveWrite();
                }
              });
            });
            await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
          }
          if (closeAfterWrites && !settled) {
            socket.end();
          }
        } catch (error) {
          socket.destroy();
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
        }
      })();
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const line of decoder.push(chunk)) {
          const frame = parseMailboxFrame(line);
          if (frame.kind === 'ack') {
            acknowledgement = frame;
            socket.destroy();
          }
        }
      } catch (error) {
        socket.destroy();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      }
    });
    socket.once('error', (error: Error) => {
      if (!connected && !settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    socket.once('end', settle);
    socket.once('close', settle);
  });
}

describe('agent messaging transport integration', () => {
  test('registers the orchestrator and peers, then delivers concurrent bidirectional messages', async () => {
    const session = await createSession();
    const rootMessages: MailboxMessageRequest[] = [];
    const workerMessages = new Map<string, MailboxMessageRequest[]>();
    const root = await register(session, orchestratorDraft('root-id'), async (request) => {
      rootMessages.push(request);
      return 'started-idle-turn';
    });
    const workerOne = await register(
      session,
      subagentDraft('worker-one-id', 'worker-one'),
      async (request) => {
        const messages = workerMessages.get('worker-one') ?? [];
        messages.push(request);
        workerMessages.set('worker-one', messages);
        if (request.content === 'queued') {
          return 'temporarily-unavailable';
        }
        if (request.content === 'idle') {
          return 'started-idle-turn';
        }
        return 'steered';
      }
    );
    const workerTwo = await register(
      session,
      subagentDraft('worker-two-id', 'worker-two'),
      async (request) => {
        const messages = workerMessages.get('worker-two') ?? [];
        messages.push(request);
        workerMessages.set('worker-two', messages);
        return 'steered';
      }
    );

    const registrations = await session.runtime.listRegistrations();
    expect(registrations.map((registration) => registration.name).sort()).toEqual([
      'orchestrator',
      'worker-one',
      'worker-two',
    ]);
    for (const handle of [root, workerOne, workerTwo]) {
      expect((await fs.stat(handle.registration.socketPath)).isSocket()).toBe(true);
      expect(
        await fs.readFile(session.runtime.registrationPath(handle.registration.id), 'utf8')
      ).toContain(handle.registration.name);
    }

    const source = identity(root);
    const concurrentAcknowledgements = await Promise.all([
      session.sendMessage(source, target('worker-one'), {
        requestId: 'steered',
        content: 'steered',
      }),
      session.sendMessage(source, target('worker-one'), {
        requestId: 'queued',
        content: 'queued',
      }),
      session.sendMessage(source, target('worker-one'), {
        requestId: 'idle',
        content: 'idle',
      }),
      ...Array.from({ length: 12 }, (_, index) =>
        session.sendMessage(source, target('worker-two'), {
          requestId: `concurrent-${index}`,
          content: `concurrent-${index}`,
        })
      ),
    ]);

    expect(
      concurrentAcknowledgements
        .slice(0, 3)
        .map((acknowledgement) =>
          acknowledgement.success ? acknowledgement.delivery : acknowledgement.error.code
        )
    ).toEqual(['steered', 'queued', 'started-idle-turn']);
    expect(
      concurrentAcknowledgements
        .slice(3)
        .every(
          (acknowledgement) => acknowledgement.success && acknowledgement.delivery === 'steered'
        )
    ).toBe(true);
    expect(workerOne.receiver.pendingCount).toBe(1);
    expect(
      workerMessages.get('worker-one')?.every((request) => request.sourceName === 'orchestrator')
    ).toBe(true);
    expect(workerMessages.get('worker-two')).toHaveLength(12);

    const [reply, peerReply] = await Promise.all([
      session.sendMessage(identity(workerOne), target('orchestrator'), {
        requestId: 'worker-reply',
        content: 'reply from worker-one',
      }),
      session.sendMessage(identity(workerTwo), target('worker-one'), {
        requestId: 'peer-reply',
        content: 'reply from worker-two',
      }),
    ]);
    expect(reply).toMatchObject({ success: true, delivery: 'started-idle-turn' });
    expect(peerReply).toMatchObject({ success: true, delivery: 'steered' });
    expect(rootMessages).toContainEqual(
      expect.objectContaining({
        sourceId: workerOne.registration.id,
        sourceName: workerOne.registration.name,
        targetName: 'orchestrator',
        content: 'reply from worker-one',
      })
    );
    expect(workerMessages.get('worker-one')).toContainEqual(
      expect.objectContaining({
        sourceId: workerTwo.registration.id,
        sourceName: workerTwo.registration.name,
        targetName: workerOne.registration.name,
        content: 'reply from worker-two',
      })
    );
  });

  test('enforces exact UTF-8 and pending FIFO boundaries through the session client', async () => {
    const session = await createSession();
    const delivered: MailboxMessageRequest[] = [];
    const exactContent = '🙂'.repeat(MAX_AGENT_MESSAGE_BYTES / 4);
    const root = await register(session, orchestratorDraft('limit-root'), async () => 'steered');
    const targetHandle = await register(
      session,
      subagentDraft('limit-target', 'limit-target'),
      async (request) => {
        delivered.push(request);
        return request.content === exactContent ? 'steered' : 'temporarily-unavailable';
      },
      { maxConnections: 128, recentRequestIdLimit: 128 }
    );

    const exactAcknowledgement = await session.sendMessage(identity(root), target('limit-target'), {
      requestId: 'exact-limit',
      content: exactContent,
    });
    expect(exactAcknowledgement).toMatchObject({ success: true, delivery: 'steered' });
    expect(Buffer.byteLength(delivered[0]?.content ?? '', 'utf8')).toBe(MAX_AGENT_MESSAGE_BYTES);

    await expectProtocolError(
      session.sendMessage(identity(root), target('limit-target'), {
        requestId: 'over-limit',
        content: `${exactContent}x`,
      }),
      'message_too_large'
    );
    expect(delivered).toHaveLength(1);

    for (let index = 1; index <= MAX_PENDING_MESSAGES_PER_RECIPIENT; index += 1) {
      const acknowledgement = await session.sendMessage(identity(root), target('limit-target'), {
        requestId: `queue-${index}`,
        content: `queue-${index}`,
      });
      expect(acknowledgement).toMatchObject({ success: true, delivery: 'queued' });
    }
    const fullAcknowledgement = await session.sendMessage(identity(root), target('limit-target'), {
      requestId: 'queue-101',
      content: 'queue-101',
    });
    expect(fullAcknowledgement).toMatchObject({
      success: false,
      requestId: 'queue-101',
      error: { code: 'queue_full' },
    });
    expect(targetHandle.receiver.pendingCount).toBe(MAX_PENDING_MESSAGES_PER_RECIPIENT);
    expect(targetHandle.receiver.drainPending().map((entry) => entry.request.content)).toEqual(
      Array.from({ length: MAX_PENDING_MESSAGES_PER_RECIPIENT }, (_, index) => `queue-${index + 1}`)
    );
    expect(targetHandle.receiver.pendingCount).toBe(0);

    const afterDrainAcknowledgement = await session.sendMessage(
      identity(root),
      target('limit-target'),
      { requestId: 'after-drain', content: 'after-drain' }
    );
    expect(afterDrainAcknowledgement).toMatchObject({
      success: true,
      delivery: 'queued',
    });
    expect(targetHandle.receiver.drainPending().map((entry) => entry.request.content)).toEqual([
      'after-drain',
    ]);
  });

  test('isolates malformed and fragmented low-level clients from a healthy receiver', async () => {
    const session = await createSession();
    const fragmentedMessages: MailboxMessageRequest[] = [];
    const healthyMessages: MailboxMessageRequest[] = [];
    const root = await register(session, orchestratorDraft('raw-root'), async () => 'steered');
    const fragmentedTarget = await register(
      session,
      subagentDraft('fragmented-target', 'fragmented-target'),
      async (request) => {
        fragmentedMessages.push(request);
        return 'steered';
      }
    );
    const healthyTarget = await register(
      session,
      subagentDraft('healthy-target', 'healthy-target'),
      async (request) => {
        healthyMessages.push(request);
        return 'steered';
      }
    );

    const fragmentedRequest = buildMailboxMessageRequest(identity(root), {
      requestId: 'fragmented-request',
      targetId: fragmentedTarget.registration.id,
      targetName: fragmentedTarget.registration.name,
      content: 'fragmented 🚀 content',
    });
    const encodedFragmentedRequest = Buffer.from(encodeMailboxFrame(fragmentedRequest), 'utf8');
    const rocketOffset = encodedFragmentedRequest.indexOf(Buffer.from('🚀', 'utf8'));
    expect(rocketOffset).toBeGreaterThan(0);
    const fragmentedAcknowledgement = await sendRawChunks(
      fragmentedTarget.registration.socketPath,
      [
        encodedFragmentedRequest.subarray(0, rocketOffset + 1),
        encodedFragmentedRequest.subarray(rocketOffset + 1),
      ]
    );
    expect(fragmentedAcknowledgement).toMatchObject({
      requestId: 'fragmented-request',
      success: true,
      delivery: 'steered',
    });
    expect(fragmentedMessages[0]?.content).toBe('fragmented 🚀 content');

    expect(
      await sendRawChunks(fragmentedTarget.registration.socketPath, [Buffer.from('not-json\n')])
    ).toBe(undefined);
    const recoverableMalformed = Buffer.from(
      JSON.stringify({
        protocolVersion: 1,
        kind: 'message',
        requestId: 'recoverable-malformed',
      }) + '\n',
      'utf8'
    );
    expect(
      await sendRawChunks(fragmentedTarget.registration.socketPath, [recoverableMalformed])
    ).toMatchObject({
      requestId: 'recoverable-malformed',
      success: false,
      error: { code: 'invalid_message' },
    });
    expect(
      await sendRawChunks(
        fragmentedTarget.registration.socketPath,
        [Buffer.from('{"protocolVersion":1,"kind":"message"', 'utf8')],
        5_000,
        true
      )
    ).toBeUndefined();
    expect(
      await sendRawChunks(fragmentedTarget.registration.socketPath, [Buffer.from([0xc3, 0x0a])])
    ).toBeUndefined();
    expect(
      await sendRawChunks(fragmentedTarget.registration.socketPath, [
        Buffer.alloc(MAX_MAILBOX_FRAME_BYTES + 1, 0x78),
      ])
    ).toBeUndefined();

    const spoofedRequest = buildMailboxMessageRequest(
      { id: 'spoofed-source', name: 'spoofed-source' },
      {
        requestId: 'spoofed-source-request',
        targetId: healthyTarget.registration.id,
        targetName: healthyTarget.registration.name,
        content: 'must not be delivered',
      }
    );
    expect(
      await sendRawChunks(healthyTarget.registration.socketPath, [
        Buffer.from(encodeMailboxFrame(spoofedRequest), 'utf8'),
      ])
    ).toMatchObject({
      requestId: 'spoofed-source-request',
      success: false,
      error: { code: 'unknown_source' },
    });
    expect(healthyMessages).toHaveLength(0);

    const healthyAcknowledgement = await session.sendMessage(
      identity(root),
      target(healthyTarget.registration.name),
      { requestId: 'healthy-after-invalid', content: 'healthy delivery' }
    );
    expect(healthyAcknowledgement).toMatchObject({
      requestId: 'healthy-after-invalid',
      success: true,
      delivery: 'steered',
    });
    expect(healthyMessages).toHaveLength(1);
    expect(healthyMessages[0]?.sourceName).toBe('orchestrator');
  });

  test('maps a closed receiver to a stale target and removes all session resources', async () => {
    const session = await createSession();
    const root = await register(session, orchestratorDraft('cleanup-root'), async () => 'steered');
    await expectProtocolError(
      session.sendMessage(identity(root), target('missing-target'), {
        requestId: 'missing-send',
        content: 'must fail promptly',
      }),
      'unknown_target'
    );
    const staleTarget = await register(
      session,
      subagentDraft('stale-target', 'stale-target'),
      async () => 'steered'
    );
    const malformedTarget = await register(
      session,
      subagentDraft('malformed-target', 'malformed-target'),
      async () => 'steered'
    );
    const healthyTarget = await register(
      session,
      subagentDraft('cleanup-healthy', 'cleanup-healthy'),
      async () => 'steered'
    );
    const rootPath = session.runtime.rootPath;
    const ownedPaths = [
      rootPath,
      session.runtime.registrationPath(root.registration.id),
      session.runtime.registrationPath(staleTarget.registration.id),
      session.runtime.registrationPath(malformedTarget.registration.id),
      session.runtime.registrationPath(healthyTarget.registration.id),
      root.registration.socketPath,
      staleTarget.registration.socketPath,
      malformedTarget.registration.socketPath,
      healthyTarget.registration.socketPath,
    ];

    await fs.writeFile(
      session.runtime.registrationPath(malformedTarget.registration.id),
      '{malformed registration\n',
      'utf8'
    );
    await expectProtocolError(
      session.sendMessage(identity(root), target('malformed-target'), {
        requestId: 'malformed-target-send',
        content: 'must fail promptly',
      }),
      'target_stale'
    );
    await staleTarget.receiver.close();
    await expectProtocolError(
      session.sendMessage(identity(root), target('stale-target'), {
        requestId: 'stale-send',
        content: 'must fail promptly',
      }),
      'target_stale'
    );
    await expect(
      session.sendMessage(identity(root), target('cleanup-healthy'), {
        requestId: 'healthy-before-close',
        content: 'still healthy',
      })
    ).resolves.toMatchObject({ success: true, delivery: 'steered' });

    await Promise.all([session.close(), session.close(), staleTarget.deregister()]);
    expect(session.isClosed).toBe(true);
    for (const path of ownedPaths) {
      await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
