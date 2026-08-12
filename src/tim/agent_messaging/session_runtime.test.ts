import { unlinkSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import net from 'node:net';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  MailboxClient,
  type MailboxSendMessageInput,
  type MailboxTargetReference,
} from './mailbox_client.js';
import {
  buildMailboxFailureAcknowledgement,
  buildMailboxSuccessAcknowledgement,
  encodeMailboxFrame,
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => {
      resolvePromise?.(value);
    },
  };
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
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

  test('atomically reserves concurrent identities by both name and opaque ID', async () => {
    const cases: Array<[string, AgentRegistrationDraft, AgentRegistrationDraft]> = [
      [
        'same name',
        subagentDraft('worker-one', 'same-name'),
        subagentDraft('worker-two', 'same-name'),
      ],
      ['same ID', subagentDraft('same-id', 'worker-one'), subagentDraft('same-id', 'worker-two')],
    ];

    for (const [label, firstDraft, secondDraft] of cases) {
      const session = await createSession();
      const results = await Promise.allSettled([
        session.register({ registration: firstDraft, deliver: () => 'steered' }),
        session.register({ registration: secondDraft, deliver: () => 'steered' }),
      ]);
      const successful = results.filter(
        (result): result is PromiseFulfilledResult<SessionRegistrationHandle> =>
          result.status === 'fulfilled'
      );

      expect(successful, label).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
        label
      ).toHaveLength(1);
      expect(await session.runtime.listRegistrations(), label).toHaveLength(1);

      await session.close();
      sessions.splice(sessions.indexOf(session), 1);
    }
  });

  test('does not publish when deregistration wins during startup', async () => {
    const session = await createSession();
    const registration = subagentDraft('startup-id', 'startup-agent');
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    const originalWriteRegistration = session.runtime.writeRegistration.bind(session.runtime);
    const writeSpy = vi
      .spyOn(session.runtime, 'writeRegistration')
      .mockImplementation(async (value, options) => {
        writeStarted.resolve(undefined);
        await releaseWrite.promise;
        return originalWriteRegistration(value, options);
      });

    const registrationPromise = session.register({ registration, deliver: () => 'steered' });
    await writeStarted.promise;
    const deregistrationPromise = session.deregister(registration.name);
    releaseWrite.resolve(undefined);

    await expect(registrationPromise).rejects.toMatchObject({ code: 'registration_failed' });
    await deregistrationPromise;
    await expect(fs.lstat(session.runtime.socketPath(registration.id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await session.runtime.listRegistrations()).toEqual([]);
    writeSpy.mockRestore();
  });

  test('does not publish when session close wins during startup', async () => {
    const session = await createSession();
    const registration = subagentDraft('closing-id', 'closing-agent');
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    const originalWriteRegistration = session.runtime.writeRegistration.bind(session.runtime);
    const writeSpy = vi
      .spyOn(session.runtime, 'writeRegistration')
      .mockImplementation(async (value, options) => {
        writeStarted.resolve(undefined);
        await releaseWrite.promise;
        return originalWriteRegistration(value, options);
      });

    const registrationPromise = session.register({ registration, deliver: () => 'steered' });
    await writeStarted.promise;
    const closePromise = session.close();
    releaseWrite.resolve(undefined);

    await expect(registrationPromise).rejects.toMatchObject({ code: 'registration_failed' });
    await closePromise;
    await expect(fs.lstat(session.runtime.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
    writeSpy.mockRestore();
    sessions.splice(sessions.indexOf(session), 1);
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

  test('does not remove a replacement registration during publication rollback', async () => {
    const session = await createSession();
    const registration = subagentDraft('replace-id', 'replace-agent');
    const expected = session.runtime.createRegistration(registration);
    const replacement = session.runtime.createRegistration({
      ...registration,
      name: 'replacement-agent',
    });
    const originalWriteRegistration = session.runtime.writeRegistration.bind(session.runtime);
    const writeSpy = vi
      .spyOn(session.runtime, 'writeRegistration')
      .mockImplementation(async (value, options) => {
        const publishedPath = await originalWriteRegistration(value, options);
        await originalWriteRegistration(replacement, { requireSocket: true });
        return publishedPath;
      });

    await expect(
      session.register({ registration, deliver: () => 'steered' })
    ).rejects.toMatchObject({ code: 'registration_failed' });
    expect(await session.runtime.readRegistration(registration.id)).toEqual(replacement);
    await expect(fs.lstat(expected.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    writeSpy.mockRestore();
  });

  test('does not treat a malformed replacement as its own registration', async () => {
    const session = await createSession();
    const registration = subagentDraft('malformed-id', 'malformed-agent');
    const expected = session.runtime.createRegistration(registration);
    const originalWriteRegistration = session.runtime.writeRegistration.bind(session.runtime);
    const writeSpy = vi
      .spyOn(session.runtime, 'writeRegistration')
      .mockImplementation(async (value, options) => {
        const publishedPath = await originalWriteRegistration(value, options);
        await fs.writeFile(publishedPath, '{malformed\n', 'utf8');
        return publishedPath;
      });

    await expect(
      session.register({ registration, deliver: () => 'steered' })
    ).rejects.toMatchObject({ code: 'registration_failed' });
    expect(await fs.readFile(session.runtime.registrationPath(registration.id), 'utf8')).toBe(
      '{malformed\n'
    );
    await expect(fs.lstat(expected.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    writeSpy.mockRestore();
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

    await expectProtocolError(
      session.sendMessage(
        { id: source.registration.id, name: source.registration.name },
        target('worker-one'),
        {
          content: 'forged fields are not part of the public send input',
          sourceId: 'forged-id',
          sourceName: 'forged-name',
        } as MailboxSendMessageInput & { sourceId: string; sourceName: string }
      ),
      'invalid_message'
    );

    const acknowledgement = await session.sendMessage(
      { id: source.registration.id, name: source.registration.name },
      target('worker-one'),
      { content: 'the only source is bound by the runtime' }
    );
    expect(acknowledgement).toMatchObject({ success: true, delivery: 'steered' });
    expect(receivedSourceName).toBe('orchestrator');
  });

  test('validates public options, targets, and message input before delivery', async () => {
    await expect(
      createAgentMessagingSessionRuntime({ connectionTimeoutMs: 0 } as never)
    ).rejects.toMatchObject({ code: 'invalid_options' });

    const session = await createSession();
    const source = await register(session, orchestratorDraft('validation-root'), () => 'steered');
    let deliveryCount = 0;
    await register(session, subagentDraft('validation-target', 'validation-target'), () => {
      deliveryCount += 1;
      return 'steered';
    });

    expect(
      () =>
        new MailboxClient({
          runtime: session.runtime,
          resolveSourceRegistration: () => source.registration,
          resolveTargetRegistration: () => undefined,
          unexpected: true,
        } as never)
    ).toThrow(MailboxProtocolError);
    expect(
      () =>
        new MailboxClient({
          runtime: session.runtime,
          resolveSourceRegistration: () => source.registration,
          resolveTargetRegistration: () => undefined,
          acknowledgementTimeoutMs: null,
        } as never)
    ).toThrow(RangeError);

    const sourceIdentity = { id: source.registration.id, name: source.registration.name };
    await expectProtocolError(
      session.sendMessage(sourceIdentity, target('validation-target'), null as never),
      'invalid_message'
    );
    await expectProtocolError(
      session.sendMessage(sourceIdentity, target('validation-target'), [] as never),
      'invalid_message'
    );
    await expectProtocolError(
      session.sendMessage(sourceIdentity, target('validation-target'), {
        content: 'bad timestamp',
        timestamp: 'not-a-timestamp',
      }),
      'invalid_message'
    );
    await expectProtocolError(
      session.sendMessage(sourceIdentity, target('validation-target'), {
        content: 'null request ID',
        requestId: null,
      } as never),
      'invalid_message'
    );
    await expectProtocolError(
      session.sendMessage(sourceIdentity, target('validation-target', ''), { content: 'bad id' }),
      'unknown_target'
    );
    await expectProtocolError(
      session.sendMessage(sourceIdentity, { name: 'validation-target', extra: true } as never, {
        content: 'extra target field',
      }),
      'unknown_target'
    );
    await expectProtocolError(
      session.sendMessage(sourceIdentity, target('validation-target'), {
        content: 'extra send field',
        sourceName: 'forged',
      } as never),
      'invalid_message'
    );
    await expect(
      session.register({
        registration: subagentDraft('bad-options', 'bad-options'),
        deliver: () => 'steered',
        maxConnections: 0,
      })
    ).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(
      session.register({
        registration: subagentDraft('bad-options-2', 'bad-options-2'),
        deliver: () => 'steered',
        unexpected: true,
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(
      session.register({
        registration: subagentDraft('bad-options-3', 'bad-options-3'),
        deliver: () => 'steered',
        maxConnections: null,
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_options' });
    expect(deliveryCount).toBe(0);
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

  test('keeps a send bound to the target snapshot across name replacement', async () => {
    const session = await createSession();
    const source = await register(session, orchestratorDraft('snapshot-root'), () => 'steered');
    const oldTarget = await register(
      session,
      subagentDraft('snapshot-old', 'snapshot-agent'),
      () => 'steered'
    );
    const lookupStarted = deferred<void>();
    const releaseLookup = deferred<void>();
    const client = new MailboxClient({
      runtime: session.runtime,
      resolveSourceRegistration: (id, name) =>
        id === source.registration.id && name === source.registration.name
          ? source.registration
          : undefined,
      resolveTargetRegistration: async (reference) => {
        if (reference.name !== oldTarget.registration.name) {
          return undefined;
        }
        lookupStarted.resolve(undefined);
        await releaseLookup.promise;
        return oldTarget.registration;
      },
      connectionTimeoutMs: 200,
      acknowledgementTimeoutMs: 200,
    });

    const sendPromise = client.sendMessage(
      { id: source.registration.id, name: source.registration.name },
      target(oldTarget.registration.name),
      { requestId: 'snapshot-request', content: 'must not reach replacement' }
    );
    await lookupStarted.promise;
    await oldTarget.deregister();
    const newTarget = await register(
      session,
      subagentDraft('snapshot-new', 'snapshot-agent'),
      () => 'steered'
    );
    releaseLookup.resolve(undefined);

    await expectProtocolError(sendPromise, 'target_stale');
    expect(newTarget.receiver.pendingCount).toBe(0);
  });

  test('maps resolver failures and malformed source or target records safely', async () => {
    const session = await createSession();
    const source = await register(session, orchestratorDraft('resolver-root'), () => 'steered');
    const targetHandle = await register(
      session,
      subagentDraft('resolver-target', 'resolver-target'),
      () => 'steered'
    );
    const base = {
      runtime: session.runtime,
      connectionTimeoutMs: 200,
      acknowledgementTimeoutMs: 200,
    } as const;
    const sourceIdentity = { id: source.registration.id, name: source.registration.name };

    const sourceThrowingClient = new MailboxClient({
      ...base,
      resolveSourceRegistration: () => {
        throw new Error('source resolver failed');
      },
      resolveTargetRegistration: () => targetHandle.registration,
    });
    await expectProtocolError(
      sourceThrowingClient.sendMessage(sourceIdentity, target('resolver-target'), {
        content: 'source resolver failure',
      }),
      'unknown_source'
    );

    const targetThrowingClient = new MailboxClient({
      ...base,
      resolveSourceRegistration: () => source.registration,
      resolveTargetRegistration: () => {
        throw new Error('target resolver failed');
      },
    });
    await expectProtocolError(
      targetThrowingClient.sendMessage(sourceIdentity, target('resolver-target'), {
        content: 'target resolver failure',
      }),
      'unknown_target'
    );

    const malformedSourceClient = new MailboxClient({
      ...base,
      resolveSourceRegistration: () =>
        ({
          ...source.registration,
          socketPath: 'relative.sock',
        }) as never,
      resolveTargetRegistration: () => targetHandle.registration,
    });
    await expectProtocolError(
      malformedSourceClient.sendMessage(sourceIdentity, target('resolver-target'), {
        content: 'malformed source',
      }),
      'unknown_source'
    );

    const malformedTargetClient = new MailboxClient({
      ...base,
      resolveSourceRegistration: () => source.registration,
      resolveTargetRegistration: () =>
        ({
          ...targetHandle.registration,
          socketPath: 'relative.sock',
        }) as never,
    });
    await expectProtocolError(
      malformedTargetClient.sendMessage(sourceIdentity, target('resolver-target'), {
        content: 'malformed target',
      }),
      'target_stale'
    );
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

  test('maps refused, reset, clean-close, partial, multiple, mismatched, and error acknowledgements', async () => {
    type Scenario = {
      readonly name: string;
      respond(socket: net.Socket): void;
      readonly expectedError?: MailboxProtocolError['code'];
      readonly expectedAcknowledgement?: MailboxAcknowledgement;
    };
    const successFrame = encodeMailboxFrame(
      buildMailboxSuccessAcknowledgement('ack-case', 'steered')
    );
    const scenarios: Scenario[] = [
      {
        name: 'reset',
        respond: (socket) => socket.destroy(),
        expectedError: 'connection_failed',
      },
      {
        name: 'clean-close',
        respond: (socket) => socket.end(),
        expectedError: 'connection_failed',
      },
      {
        name: 'partial',
        respond: (socket) => {
          socket.write(successFrame.slice(0, -3));
          socket.end();
        },
        expectedError: 'invalid_ack',
      },
      {
        name: 'multiple',
        respond: (socket) => socket.end(`${successFrame}${successFrame}`),
        expectedError: 'invalid_ack',
      },
      {
        name: 'mismatched',
        respond: (socket) =>
          socket.end(
            encodeMailboxFrame(buildMailboxSuccessAcknowledgement('other-request', 'steered'))
          ),
        expectedError: 'invalid_ack',
      },
      {
        name: 'error-acknowledgement',
        respond: (socket) =>
          socket.end(
            encodeMailboxFrame(
              buildMailboxFailureAcknowledgement('ack-case', 'target_stale', 'target was replaced')
            )
          ),
        expectedAcknowledgement: buildMailboxFailureAcknowledgement(
          'ack-case',
          'target_stale',
          'target was replaced'
        ),
      },
    ];

    for (const scenario of scenarios) {
      const session = await createSession({
        connectionTimeoutMs: 200,
        acknowledgementTimeoutMs: 100,
      });
      const source = await register(
        session,
        orchestratorDraft(`ack-root-${scenario.name}`),
        () => 'steered'
      );
      const targetRegistration = session.runtime.createRegistration(
        subagentDraft(`ack-target-${scenario.name}`, `ack-${scenario.name}`)
      );
      const server = net.createServer(scenario.respond);
      await listen(server, targetRegistration.socketPath);
      await session.runtime.writeRegistration(targetRegistration, { requireSocket: true });
      const client = new MailboxClient({
        runtime: session.runtime,
        resolveSourceRegistration: () => source.registration,
        resolveTargetRegistration: () => targetRegistration,
        connectionTimeoutMs: 200,
        acknowledgementTimeoutMs: 100,
      });

      const sendPromise = client.sendMessage(
        { id: source.registration.id, name: source.registration.name },
        target(targetRegistration.name),
        { requestId: 'ack-case', content: scenario.name }
      );
      if (scenario.expectedError !== undefined) {
        await expectProtocolError(sendPromise, scenario.expectedError);
      } else {
        await expect(sendPromise).resolves.toEqual(scenario.expectedAcknowledgement);
      }
      await closeServer(server);
      await fs.rm(targetRegistration.socketPath, { force: true });
      await session.runtime.removeRegistration(targetRegistration.id);
    }
  });

  test('uses the acknowledgement deadline only after the connection is established', async () => {
    const session = await createSession({ connectionTimeoutMs: 20, acknowledgementTimeoutMs: 200 });
    const source = await register(session, orchestratorDraft('deadline-root'), () => 'steered');
    const targetRegistration = session.runtime.createRegistration(
      subagentDraft('deadline-target', 'deadline-target')
    );
    const server = net.createServer((socket) => {
      setTimeout(() => {
        socket.end(encodeMailboxFrame(buildMailboxSuccessAcknowledgement('deadline', 'steered')));
      }, 50);
    });
    await listen(server, targetRegistration.socketPath);
    await session.runtime.writeRegistration(targetRegistration, { requireSocket: true });
    const client = new MailboxClient({
      runtime: session.runtime,
      resolveSourceRegistration: () => source.registration,
      resolveTargetRegistration: () => targetRegistration,
      connectionTimeoutMs: 20,
      acknowledgementTimeoutMs: 200,
    });

    await expect(
      client.sendMessage(
        { id: source.registration.id, name: source.registration.name },
        target(targetRegistration.name),
        { requestId: 'deadline', content: 'connection was already ready' }
      )
    ).resolves.toMatchObject({ success: true, delivery: 'steered' });
    await closeServer(server);
    await fs.rm(targetRegistration.socketPath, { force: true });
    await session.runtime.removeRegistration(targetRegistration.id);
  });

  test('maps a refused target and rejects a socket removed after validation', async () => {
    const session = await createSession({
      connectionTimeoutMs: 200,
      acknowledgementTimeoutMs: 100,
    });
    const source = await register(session, orchestratorDraft('refused-root'), () => 'steered');
    const refusedRegistration = session.runtime.createRegistration(
      subagentDraft('refused-target', 'refused-target')
    );
    const refusedServer = net.createServer();
    await listen(refusedServer, refusedRegistration.socketPath);
    await session.runtime.writeRegistration(refusedRegistration, { requireSocket: true });
    await closeServer(refusedServer);
    const refusedClient = new MailboxClient({
      runtime: session.runtime,
      resolveSourceRegistration: () => source.registration,
      resolveTargetRegistration: () => refusedRegistration,
      connectionTimeoutMs: 200,
      acknowledgementTimeoutMs: 100,
    });
    await expectProtocolError(
      refusedClient.sendMessage(
        { id: source.registration.id, name: source.registration.name },
        target(refusedRegistration.name),
        { content: 'refused' }
      ),
      'target_stale'
    );
    await fs.rm(refusedRegistration.socketPath, { force: true });
    await session.runtime.removeRegistration(refusedRegistration.id);

    const replacementRegistration = session.runtime.createRegistration(
      subagentDraft('replacement-target', 'replacement-target')
    );
    const replacementPath = replacementRegistration.socketPath;
    const originalReadRegistration = session.runtime.readRegistration.bind(session.runtime);
    let readCount = 0;
    const readRegistrationSpy = vi
      .spyOn(session.runtime, 'readRegistration')
      .mockImplementation(async (idOrPath) => {
        const value = await originalReadRegistration(idOrPath);
        readCount += 1;
        if (readCount === 2) {
          unlinkSync(replacementPath);
        }
        return value;
      });
    const originalServer = net.createServer((socket) => {
      socket.pause();
    });
    await listen(originalServer, replacementPath);
    await session.runtime.writeRegistration(replacementRegistration, { requireSocket: true });
    const replacementClient = new MailboxClient({
      runtime: session.runtime,
      resolveSourceRegistration: () => source.registration,
      resolveTargetRegistration: () => replacementRegistration,
      connectionTimeoutMs: 200,
      acknowledgementTimeoutMs: 100,
    });
    await expectProtocolError(
      replacementClient.sendMessage(
        { id: source.registration.id, name: source.registration.name },
        target(replacementRegistration.name),
        { content: 'replacement race' }
      ),
      'target_stale'
    );
    await closeServer(originalServer);
    readRegistrationSpy.mockRestore();
    await fs.rm(replacementPath, { force: true });
    await session.runtime.removeRegistration(replacementRegistration.id);
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

  test('closes parallel deregistration and all receivers before removing the root', async () => {
    const session = await createSession();
    const unrelatedRoot = await fs.mkdtemp('/tmp/tm-unrelated-');
    const registrations = await Promise.all([
      register(session, orchestratorDraft('parallel-root'), () => 'steered'),
      register(session, subagentDraft('parallel-one', 'parallel-one'), () => 'steered'),
      register(session, subagentDraft('parallel-two', 'parallel-two'), () => 'steered'),
      register(session, subagentDraft('parallel-three', 'parallel-three'), () => 'steered'),
    ]);
    const rootPath = session.runtime.rootPath;
    const deregisterPromise = registrations[1]?.deregister();

    await Promise.all([deregisterPromise, session.close(), session.close()]);
    await expect(fs.lstat(rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(unrelatedRoot)).resolves.toBeTruthy();
    await fs.rm(unrelatedRoot, { recursive: true, force: true });
    sessions.splice(sessions.indexOf(session), 1);
  });
});
