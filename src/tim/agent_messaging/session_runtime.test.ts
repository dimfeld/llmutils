import { promises as fs } from 'node:fs';
import net from 'node:net';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  MailboxClient,
  type MailboxSendMessageInput,
  type MailboxTargetReference,
} from './mailbox_client.js';
import {
  MailboxProtocolError,
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

async function createSession(
  options: Parameters<typeof createAgentMessagingSessionRuntime>[0] = {}
): Promise<AgentMessagingSessionRuntime> {
  const session = await createAgentMessagingSessionRuntime(options);
  sessions.push(session);
  return session;
}

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

async function register(
  session: AgentMessagingSessionRuntime,
  registration: AgentRegistrationDraft,
  deliver: (
    request: MailboxMessageRequest
  ) => 'steered' | 'started-idle-turn' | 'temporarily-unavailable'
): Promise<SessionRegistrationHandle> {
  return session.register({
    registration,
    deliver: async (request) => deliver(request),
  });
}

function target(name: string, id?: string): MailboxTargetReference {
  return id === undefined ? { name } : { name, id };
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

describe('agent messaging session runtime', () => {
  test('publishes only after the real receiver is ready and delivers all dispositions', async () => {
    const session = await createSession();
    const received: MailboxMessageRequest[] = [];
    const source = await register(session, orchestratorDraft('root-id'), () => 'steered');
    const targetHandle = await register(
      session,
      subagentDraft('worker-id', 'worker-one'),
      (request) => {
        received.push(request);
        if (request.content === 'queued') {
          return 'temporarily-unavailable';
        }
        if (request.content === 'idle') {
          return 'started-idle-turn';
        }
        return 'steered';
      }
    );

    expect(
      await fs.stat(session.runtime.registrationPath(targetHandle.registration.id))
    ).toBeTruthy();
    expect((await fs.stat(targetHandle.registration.socketPath)).isSocket()).toBe(true);

    const sourceIdentity = { id: source.registration.id, name: source.registration.name };
    const acknowledgements = await Promise.all([
      session.sendMessage(sourceIdentity, target('worker-one'), {
        requestId: 'request-steered',
        content: 'steer',
      }),
      session.sendMessage(sourceIdentity, target('worker-one'), {
        requestId: 'request-queued',
        content: 'queued',
      }),
      session.sendMessage(sourceIdentity, target('worker-one'), {
        requestId: 'request-idle',
        content: 'idle',
      }),
    ]);

    expect(acknowledgements.map((ack) => ack.success && ack.delivery)).toEqual([
      'steered',
      'queued',
      'started-idle-turn',
    ]);
    expect(received.map((request) => request.sourceName)).toEqual([
      'orchestrator',
      'orchestrator',
      'orchestrator',
    ]);
    expect(targetHandle.receiver.pendingCount).toBe(1);
  });

  test('rolls back the receiver when atomic registration publication fails', async () => {
    const session = await createSession();
    const registration = subagentDraft('worker-id', 'worker-one');
    const expected = session.runtime.createRegistration(registration);
    const writeRegistration = vi
      .spyOn(session.runtime, 'writeRegistration')
      .mockRejectedValueOnce(new Error('simulated publication failure'));

    await expect(
      session.register({ registration, deliver: () => 'steered' })
    ).rejects.toMatchObject({ code: 'registration_failed' });
    await expect(fs.lstat(expected.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(session.runtime.registrationPath(expected.id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await session.runtime.listRegistrations()).toEqual([]);
    writeRegistration.mockRestore();
  });

  test('uses the active source registration and rejects source spoofing', async () => {
    const session = await createSession();
    const source = await register(session, orchestratorDraft('root-id'), () => 'steered');
    let receivedSourceName: string | undefined;
    await register(session, subagentDraft('worker-id', 'worker-one'), (request) => {
      receivedSourceName = request.sourceName;
      return 'steered';
    });

    await expectProtocolError(
      session.sendMessage(
        { id: source.registration.id, name: 'spoofed-source' },
        target('worker-one'),
        { content: 'must fail' }
      ),
      'unknown_source'
    );

    const acknowledgement = await session.sendMessage(
      { id: source.registration.id, name: source.registration.name },
      target('worker-one'),
      {
        content: 'the only source is bound by the runtime',
        sourceId: 'forged-id',
        sourceName: 'forged-name',
      } as MailboxSendMessageInput & { sourceId: string; sourceName: string }
    );
    expect(acknowledgement).toMatchObject({ success: true, delivery: 'steered' });
    expect(receivedSourceName).toBe('orchestrator');
  });

  test('accepts the exact UTF-8 boundary and rejects larger content before delivery', async () => {
    const session = await createSession();
    const source = await register(session, orchestratorDraft('root-id'), () => 'steered');
    const delivered: MailboxMessageRequest[] = [];
    await register(session, subagentDraft('worker-id', 'worker-one'), (request) => {
      delivered.push(request);
      return 'steered';
    });

    const exactContent = '🙂'.repeat(16_384);
    const exactAck = await session.sendMessage(
      { id: source.registration.id, name: source.registration.name },
      target('worker-one'),
      { requestId: 'exact-limit', content: exactContent }
    );
    expect(exactAck).toMatchObject({ success: true, delivery: 'steered' });
    expect(Buffer.byteLength(delivered[0]?.content ?? '', 'utf8')).toBe(65_536);

    await expectProtocolError(
      session.sendMessage(
        { id: source.registration.id, name: source.registration.name },
        target('worker-one'),
        { requestId: 'over-limit', content: `${exactContent}x` }
      ),
      'message_too_large'
    );
    expect(delivered).toHaveLength(1);
  });

  test('supports bidirectional delivery and concurrent sends with trusted attribution', async () => {
    const session = await createSession();
    const sourceMessages: MailboxMessageRequest[] = [];
    const targetMessages: MailboxMessageRequest[] = [];
    const source = await register(session, orchestratorDraft('root-id'), (request) => {
      sourceMessages.push(request);
      return 'started-idle-turn';
    });
    const targetHandle = await register(
      session,
      subagentDraft('worker-id', 'worker-one'),
      (request) => {
        targetMessages.push(request);
        return 'steered';
      }
    );

    const sourceIdentity = { id: source.registration.id, name: source.registration.name };
    const targetIdentity = {
      id: targetHandle.registration.id,
      name: targetHandle.registration.name,
    };
    const targetAcks = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        session.sendMessage(sourceIdentity, target('worker-one'), {
          requestId: `concurrent-${index}`,
          content: `message-${index}`,
        })
      )
    );
    const sourceAck = await session.sendMessage(targetIdentity, target('orchestrator'), {
      requestId: 'reply',
      content: 'reply-to-root',
    });

    expect(targetAcks.every((ack) => ack.success && ack.delivery === 'steered')).toBe(true);
    expect(sourceAck).toMatchObject({ success: true, delivery: 'started-idle-turn' });
    expect(targetMessages).toHaveLength(12);
    expect(targetMessages.every((request) => request.sourceName === 'orchestrator')).toBe(true);
    expect(sourceMessages[0]?.sourceName).toBe('worker-one');
  });

  test('binds sends to one target snapshot and rejects replacement IDs', async () => {
    const session = await createSession();
    const source = await register(session, orchestratorDraft('root-id'), () => 'steered');
    const oldTarget = await register(
      session,
      subagentDraft('old-id', 'worker-one'),
      () => 'steered'
    );
    await oldTarget.deregister();
    await expectProtocolError(
      session.sendMessage(
        { id: source.registration.id, name: source.registration.name },
        target('worker-one', oldTarget.registration.id),
        { content: 'old target' }
      ),
      'unknown_target'
    );

    const newTarget = await register(
      session,
      subagentDraft('new-id', 'worker-one'),
      () => 'steered'
    );
    const acknowledgement = await session.sendMessage(
      { id: source.registration.id, name: source.registration.name },
      target('worker-one'),
      { content: 'new target' }
    );
    expect(acknowledgement).toMatchObject({ success: true, delivery: 'steered' });
    expect(newTarget.registration.id).not.toBe(oldTarget.registration.id);
  });

  test('maps missing, malformed, and missing-socket registrations to target_stale', async () => {
    const cases = [
      async (
        session: AgentMessagingSessionRuntime,
        handle: SessionRegistrationHandle
      ): Promise<void> => {
        await session.runtime.removeRegistration(handle.registration.id);
      },
      async (
        session: AgentMessagingSessionRuntime,
        handle: SessionRegistrationHandle
      ): Promise<void> => {
        await fs.writeFile(
          session.runtime.registrationPath(handle.registration.id),
          '{broken\n',
          'utf8'
        );
      },
      async (
        session: AgentMessagingSessionRuntime,
        handle: SessionRegistrationHandle
      ): Promise<void> => {
        await session.runtime.removeSocket(handle.registration.id);
      },
    ];

    for (const [index, mutate] of cases.entries()) {
      const session = await createSession();
      const source = await register(session, orchestratorDraft(`root-${index}`), () => 'steered');
      const targetHandle = await register(
        session,
        subagentDraft(`worker-${index}`, `worker-${index}`),
        () => 'steered'
      );
      await mutate(session, targetHandle);
      await expectProtocolError(
        session.sendMessage(
          { id: source.registration.id, name: source.registration.name },
          target(targetHandle.registration.name),
          { content: 'stale' }
        ),
        'target_stale'
      );
      await session.close();
      sessions.splice(sessions.indexOf(session), 1);
    }
  });

  test('fails promptly when the receiver exits during an acknowledged send', async () => {
    const session = await createSession({ acknowledgementTimeoutMs: 200 });
    const source = await register(session, orchestratorDraft('root-id'), () => 'steered');
    let resolveDelivery: (() => void) | undefined;
    let deliveryStarted: (() => void) | undefined;
    const deliveryBlocked = new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    });
    const deliveryStartedPromise = new Promise<void>((resolve) => {
      deliveryStarted = resolve;
    });
    const targetHandle = await register(
      session,
      subagentDraft('worker-id', 'worker-one'),
      async () => {
        deliveryStarted?.();
        await deliveryBlocked;
        return 'steered';
      }
    );

    const sendPromise = session.sendMessage(
      { id: source.registration.id, name: source.registration.name },
      target('worker-one'),
      { content: 'close during send' }
    );
    const sendAssertion = expectProtocolError(sendPromise, 'connection_failed');
    await deliveryStartedPromise;
    await targetHandle.receiver.close();
    await sendAssertion;
    resolveDelivery?.();
  });

  test('maps acknowledgement timeout and invalid acknowledgement from real Unix servers', async () => {
    const session = await createSession({ connectionTimeoutMs: 200, acknowledgementTimeoutMs: 30 });
    const source = await register(session, orchestratorDraft('root-id'), () => 'steered');
    const targetRegistration = session.runtime.createRegistration(
      subagentDraft('raw-id', 'raw-target')
    );
    const sourceRegistration = source.registration;
    const active = new Map<string, typeof sourceRegistration>([
      [sourceRegistration.id, sourceRegistration],
      [targetRegistration.id, targetRegistration],
    ]);
    const client = new MailboxClient({
      runtime: session.runtime,
      resolveSourceRegistration: (id, name) => {
        const registration = active.get(id);
        return registration?.name === name ? registration : undefined;
      },
      resolveTargetRegistration: () => targetRegistration,
      connectionTimeoutMs: 200,
      acknowledgementTimeoutMs: 30,
    });

    let server = net.createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(targetRegistration.socketPath, resolve);
    });
    await session.runtime.writeRegistration(targetRegistration, { requireSocket: true });
    await expectProtocolError(
      client.sendMessage(
        { id: sourceRegistration.id, name: sourceRegistration.name },
        target('raw-target'),
        { content: 'wait' }
      ),
      'ack_timeout'
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));

    server = net.createServer((socket) => {
      socket.end('{"kind":"ack"}\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(targetRegistration.socketPath, resolve);
    });
    await expectProtocolError(
      client.sendMessage(
        { id: sourceRegistration.id, name: sourceRegistration.name },
        target('raw-target'),
        { content: 'invalid ack' }
      ),
      'invalid_ack'
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(targetRegistration.socketPath, { force: true });
    await session.runtime.removeRegistration(targetRegistration.id);
  });

  test('deregistration and session close are idempotent and remove the exact root', async () => {
    const session = await createSession();
    const source = await register(session, orchestratorDraft('root-id'), () => 'steered');
    const targetHandle = await register(
      session,
      subagentDraft('worker-id', 'worker-one'),
      () => 'steered'
    );
    const rootPath = session.runtime.rootPath;

    await Promise.all([targetHandle.deregister(), targetHandle.deregister()]);
    await expectProtocolError(
      session.sendMessage(
        { id: source.registration.id, name: source.registration.name },
        target('worker-one'),
        { content: 'after deregister' }
      ),
      'unknown_target'
    );
    await Promise.all([session.close(), session.close()]);
    await expect(fs.lstat(rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await session.close();
  });
});
