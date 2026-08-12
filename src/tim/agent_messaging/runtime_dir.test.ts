import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { CleanupRegistry } from '../../common/cleanup_registry.js';
import { MAILBOX_PROTOCOL_VERSION, MAX_MAILBOX_AGENT_ID_LENGTH } from './mailbox_protocol.js';
import {
  AGENT_MESSAGING_RUNTIME_PREFIX,
  MAX_REGISTRATION_FILE_BYTES,
  MAX_REGISTRATION_SOCKET_PATH_BYTES,
  MAX_UNIX_SOCKET_PATH_BYTES,
  REGISTRATION_FILE_MODE,
  RUNTIME_DIRECTORY_MODE,
  AgentMessagingRuntimeDirectoryError,
  createAgentMessagingRuntimeDirectory,
  isStrictPathDescendant,
  parseAgentRegistration,
  type AgentMessagingRuntimeDirectory,
  type AgentRegistration,
} from './runtime_dir.js';

describe('agent_messaging/runtime_dir', () => {
  const runtimes: AgentMessagingRuntimeDirectory[] = [];

  afterEach(async () => {
    await Promise.all(
      runtimes.splice(0).map(async (runtime) => {
        await runtime.close().catch(() => undefined);
      })
    );
  });

  async function createRuntime(): Promise<AgentMessagingRuntimeDirectory> {
    const runtime = await createAgentMessagingRuntimeDirectory();
    runtimes.push(runtime);
    return runtime;
  }

  function subagentRegistration(
    runtime: AgentMessagingRuntimeDirectory,
    overrides: Partial<AgentRegistration> = {}
  ): AgentRegistration {
    return runtime.createRegistration({
      id: 'worker-id',
      name: 'worker-one',
      role: 'subagent',
      type: 'tester',
      executor: 'codex-cli',
      state: 'running-idle',
      ...(overrides as Partial<Extract<AgentRegistration, { role: 'subagent' }>>),
    });
  }

  test('creates short private root, agents, and sockets directories', async () => {
    const runtime = await createRuntime();

    expect(path.dirname(runtime.rootPath)).toBe(os.tmpdir());
    expect(path.basename(runtime.rootPath)).toMatch(
      new RegExp(`^${AGENT_MESSAGING_RUNTIME_PREFIX}`)
    );
    expect(fs.statSync(runtime.rootPath).isDirectory()).toBe(true);
    expect(fs.statSync(runtime.agentsDirectory).isDirectory()).toBe(true);
    expect(fs.statSync(runtime.socketsDirectory).isDirectory()).toBe(true);

    if (process.platform !== 'win32') {
      for (const directory of [
        runtime.rootPath,
        runtime.agentsDirectory,
        runtime.socketsDirectory,
      ]) {
        expect(fs.statSync(directory).mode & 0o777).toBe(RUNTIME_DIRECTORY_MODE);
      }
    }
  });

  test('derives opaque-ID paths and enforces the conservative socket length', async () => {
    const runtime = await createRuntime();
    const id = 'opaque-agent-id';

    expect(path.basename(runtime.registrationPath(id))).toBe(`${id}.json`);
    expect(path.basename(runtime.socketPath(id))).toBe(`${id}.sock`);
    expect(runtime.registrationPath(id)).not.toContain('worker-one');
    expect(Buffer.byteLength(runtime.socketPath(id), 'utf8')).toBeLessThanOrEqual(
      MAX_UNIX_SOCKET_PATH_BYTES
    );

    expect(() => runtime.registrationPath('')).toThrow(AgentMessagingRuntimeDirectoryError);
    expect(() => runtime.socketPath('../outside')).toThrow(AgentMessagingRuntimeDirectoryError);
    expect(() => runtime.socketPath('nested/id')).toThrow(AgentMessagingRuntimeDirectoryError);
    expect(() => runtime.socketPath('nested\\id')).toThrow(AgentMessagingRuntimeDirectoryError);
    expect(() => runtime.socketPath('a'.repeat(MAX_MAILBOX_AGENT_ID_LENGTH))).toThrow(
      AgentMessagingRuntimeDirectoryError
    );
    expect(() => runtime.socketPath('a'.repeat(MAX_MAILBOX_AGENT_ID_LENGTH + 1))).toThrow(
      AgentMessagingRuntimeDirectoryError
    );

    const socketPathPrefixBytes = Buffer.byteLength(
      `${runtime.socketsDirectory}${path.sep}`,
      'utf8'
    );
    const exactLengthId = 'a'.repeat(
      MAX_UNIX_SOCKET_PATH_BYTES - socketPathPrefixBytes - Buffer.byteLength('.sock', 'utf8')
    );
    expect(Buffer.byteLength(runtime.socketPath(exactLengthId), 'utf8')).toBe(
      MAX_UNIX_SOCKET_PATH_BYTES
    );
    expect(() => runtime.socketPath(`${exactLengthId}a`)).toThrow(
      AgentMessagingRuntimeDirectoryError
    );

    for (const invalidId of [
      '',
      '.',
      '..',
      '../outside',
      '/absolute-id',
      'nested/id',
      'nested\\id',
      'line\nbreak',
      'null\0byte',
    ]) {
      expect(() => runtime.registrationPath(invalidId), invalidId).toThrow(
        AgentMessagingRuntimeDirectoryError
      );
    }

    const dotPrefixedId = '..opaque-id';
    expect(isStrictPathDescendant(runtime.rootPath, runtime.socketPath(dotPrefixedId))).toBe(true);
  });

  test('uses the correct strict descendant test for dot-prefixed child names', async () => {
    const runtime = await createRuntime();
    const insideDotName = path.join(runtime.rootPath, '..foo');

    expect(isStrictPathDescendant(runtime.rootPath, insideDotName)).toBe(true);
    expect(isStrictPathDescendant(runtime.rootPath, path.join(runtime.rootPath, '..'))).toBe(false);
    expect(
      isStrictPathDescendant(runtime.rootPath, path.join(runtime.rootPath, '..', 'outside'))
    ).toBe(false);
  });

  test('creates and strictly validates orchestrator and subagent registration shapes', async () => {
    const runtime = await createRuntime();
    const orchestrator = runtime.createRegistration({
      id: 'root-id',
      name: 'orchestrator',
      role: 'orchestrator',
      executor: 'claude-code',
      state: 'running-active',
    });
    const subagent = subagentRegistration(runtime);

    expect(orchestrator).toEqual({
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      id: 'root-id',
      name: 'orchestrator',
      role: 'orchestrator',
      executor: 'claude-code',
      state: 'running-active',
      socketPath: runtime.socketPath('root-id'),
    });
    expect(await runtime.writeRegistration(orchestrator)).toBe(runtime.registrationPath('root-id'));
    expect(await runtime.writeRegistration(subagent)).toBe(runtime.registrationPath('worker-id'));
    expect(await runtime.readRegistration('root-id')).toEqual(orchestrator);
    expect(await runtime.readRegistration(runtime.registrationPath('worker-id'))).toEqual(subagent);

    expect(() =>
      runtime.createRegistration({
        id: 'bad/id',
        name: 'worker-one',
        role: 'subagent',
        type: 'tester',
        executor: 'codex-cli',
        state: 'running-idle',
      })
    ).toThrow(AgentMessagingRuntimeDirectoryError);
    await expect(
      runtime.writeRegistration({ ...subagent, protocolVersion: 2 } as never)
    ).rejects.toThrow(AgentMessagingRuntimeDirectoryError);
    await expect(
      runtime.writeRegistration({ ...subagent, unexpected: true } as never)
    ).rejects.toThrow(AgentMessagingRuntimeDirectoryError);
  });

  test('strictly validates registration fields and byte-sized boundaries', async () => {
    const runtime = await createRuntime();
    const valid = subagentRegistration(runtime);

    expect(parseAgentRegistration(valid)).toEqual(valid);
    expect(() => parseAgentRegistration({ ...valid, unexpected: true })).toThrow(
      AgentMessagingRuntimeDirectoryError
    );
    expect(() => parseAgentRegistration({ ...valid, type: undefined })).toThrow(
      AgentMessagingRuntimeDirectoryError
    );
    expect(() => parseAgentRegistration({ ...valid, role: 'orchestrator' })).toThrow(
      AgentMessagingRuntimeDirectoryError
    );
    expect(() => parseAgentRegistration({ ...valid, socketPath: 'relative.sock' })).toThrow(
      AgentMessagingRuntimeDirectoryError
    );
    expect(() =>
      parseAgentRegistration({ ...valid, id: 'a'.repeat(MAX_MAILBOX_AGENT_ID_LENGTH + 1) })
    ).toThrow(AgentMessagingRuntimeDirectoryError);

    const maxSocketPath = `/${'a'.repeat(MAX_REGISTRATION_SOCKET_PATH_BYTES - 1)}`;
    expect(parseAgentRegistration({ ...valid, socketPath: maxSocketPath }).socketPath).toBe(
      maxSocketPath
    );
    expect(() =>
      parseAgentRegistration({
        ...valid,
        socketPath: `/${'a'.repeat(MAX_REGISTRATION_SOCKET_PATH_BYTES)}`,
      })
    ).toThrow(AgentMessagingRuntimeDirectoryError);

    const oversizedPath = runtime.registrationPath(valid.id);
    await writeFile(oversizedPath, 'x'.repeat(MAX_REGISTRATION_FILE_BYTES + 1), 'utf8');
    await fs.promises.chmod(oversizedPath, REGISTRATION_FILE_MODE);
    await expect(runtime.readRegistration(valid.id)).rejects.toMatchObject({
      code: 'invalid_registration',
    });
  });

  test('maps a missing registration leaf to registration_not_found', async () => {
    const runtime = await createRuntime();

    await expect(runtime.readRegistration('missing-agent')).rejects.toMatchObject({
      code: 'registration_not_found',
    });
  });

  test('writes registration files with owner-only mode and atomically replaces them', async () => {
    const runtime = await createRuntime();
    const initial = subagentRegistration(runtime);
    const updated = runtime.createRegistration({
      id: 'worker-id',
      name: 'worker-one',
      role: 'subagent',
      type: 'tester',
      executor: 'claude-code',
      state: 'running-active',
    });

    const registrationPath = await runtime.writeRegistration(initial);
    if (process.platform !== 'win32') {
      expect(fs.statSync(registrationPath).mode & 0o777).toBe(REGISTRATION_FILE_MODE);
    }

    await runtime.writeRegistration(updated);
    expect(await runtime.readRegistration('worker-id')).toEqual(updated);

    const names = await readdir(runtime.agentsDirectory);
    expect(names).toEqual(['worker-id.json']);
    expect(JSON.parse(await readFile(registrationPath, 'utf8'))).toEqual(updated);
  });

  test('keeps final records valid across overlapping atomic rewrites', async () => {
    const runtime = await createRuntime();
    const versions = Array.from({ length: 12 }, (_, index) =>
      runtime.createRegistration({
        id: 'worker-id',
        name: 'worker-one',
        role: 'subagent',
        type: index % 2 === 0 ? 'tester' : 'implementer',
        executor: index % 2 === 0 ? 'codex-cli' : 'claude-code',
        state: index % 2 === 0 ? 'running-idle' : 'running-active',
      })
    );

    await Promise.all(
      versions.map(
        (registration, index) =>
          new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              runtime.writeRegistration(registration).then(() => resolve(), reject);
            }, index % 3);
          })
      )
    );

    const final = await runtime.readRegistration('worker-id');
    expect(versions).toContainEqual(final);
    expect(JSON.parse(await readFile(runtime.registrationPath('worker-id'), 'utf8'))).toEqual(
      final
    );
  });

  test('never exposes a partial record while readers overlap atomic rewrites', async () => {
    const runtime = await createRuntime();
    const versions = Array.from({ length: 40 }, (_, index) =>
      runtime.createRegistration({
        id: 'worker-id',
        name: 'worker-one',
        role: 'subagent',
        type: index % 2 === 0 ? 'tester' : 'implementer',
        executor: index % 2 === 0 ? 'codex-cli' : 'claude-code',
        state: index % 2 === 0 ? 'running-idle' : 'running-active',
      })
    );
    await runtime.writeRegistration(versions[0]);

    const writer = (async (): Promise<void> => {
      for (const [index, registration] of versions.entries()) {
        await runtime.writeRegistration(registration);
        if (index % 4 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    })();
    const reader = (async (): Promise<AgentRegistration[]> => {
      const observed: AgentRegistration[] = [];
      for (let index = 0; index < 120; index += 1) {
        observed.push(await runtime.readRegistration('worker-id'));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return observed;
    })();

    const [, observed] = await Promise.all([writer, reader]);
    expect(observed).not.toHaveLength(0);
    for (const registration of observed) {
      expect(versions).toContainEqual(registration);
    }
    expect(
      (await readdir(runtime.agentsDirectory)).filter((name) => name.includes('.tmp.'))
    ).toEqual([]);
  });

  test('lists valid final files, ignores temporary and malformed files, and can report malformed files', async () => {
    const runtime = await createRuntime();
    const valid = subagentRegistration(runtime);
    await runtime.writeRegistration(valid);

    await writeFile(path.join(runtime.agentsDirectory, 'bad.json'), '{not-json', 'utf8');
    await writeFile(
      path.join(runtime.agentsDirectory, 'invalid.json'),
      JSON.stringify({ protocolVersion: MAILBOX_PROTOCOL_VERSION, id: 'invalid' }),
      'utf8'
    );
    await writeFile(path.join(runtime.agentsDirectory, 'temporary.json.tmp.1'), '{}', 'utf8');
    await writeFile(path.join(runtime.agentsDirectory, 'temporary.tmp.1.json'), '{}', 'utf8');
    await fs.promises.mkdir(path.join(runtime.agentsDirectory, 'directory.json'));

    expect(await runtime.listRegistrations()).toEqual([valid]);
    await expect(runtime.listRegistrations({ skipMalformed: false })).rejects.toThrow(
      AgentMessagingRuntimeDirectoryError
    );

    const movedAgentsDirectory = path.join(runtime.rootPath, 'agents-real');
    await fs.promises.rename(runtime.agentsDirectory, movedAgentsDirectory);
    await fs.promises.symlink(movedAgentsDirectory, runtime.agentsDirectory);
    await expect(runtime.listRegistrations()).rejects.toThrow(AgentMessagingRuntimeDirectoryError);
  });

  test('rejects malformed public option objects and fields', async () => {
    const runtime = await createRuntime();
    const registration = subagentRegistration(runtime);

    await expect(
      runtime.listRegistrations({ skipMalformed: 'yes' } as never)
    ).rejects.toMatchObject({ code: 'invalid_registration' });
    await expect(
      runtime.validateSocketPath(runtime.socketPath(registration.id), {
        allowMissing: 'yes',
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_registration' });
    await expect(
      runtime.writeRegistration(registration, { requireSocket: 'yes' } as never)
    ).rejects.toMatchObject({ code: 'invalid_registration' });
    await expect(
      runtime.writeRegistration(registration, { unexpected: true } as never)
    ).rejects.toMatchObject({ code: 'invalid_registration' });
    expect(fs.existsSync(runtime.registrationPath(registration.id))).toBe(false);
  });

  test('rejects symlinked registration entries and socket path components', async () => {
    const runtime = await createRuntime();
    const valid = subagentRegistration(runtime);
    const validPath = await runtime.writeRegistration(valid);
    const symlinkPath = path.join(runtime.agentsDirectory, 'linked.json');
    await fs.promises.symlink(validPath, symlinkPath);

    await expect(runtime.readRegistration('linked')).rejects.toThrow(
      AgentMessagingRuntimeDirectoryError
    );
    expect(await runtime.listRegistrations()).toEqual([valid]);

    const socketPath = runtime.socketPath('worker-id');
    await fs.promises.symlink(runtime.rootPath, path.join(runtime.socketsDirectory, 'link'));
    await expect(
      runtime.validateSocketPath(path.join(runtime.socketsDirectory, 'link', 'socket.sock'), {
        allowMissing: true,
      })
    ).rejects.toThrow(AgentMessagingRuntimeDirectoryError);

    await fs.promises.symlink(runtime.rootPath, socketPath);
    await expect(runtime.validateSocketPath(socketPath, { allowMissing: true })).rejects.toThrow(
      AgentMessagingRuntimeDirectoryError
    );
  });

  test('does not overwrite or remove symlinked final entries', async () => {
    const runtime = await createRuntime();
    const registration = subagentRegistration(runtime);
    const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), 'tm-agent-outside-'));
    const outsideFile = path.join(outsideDirectory, 'outside.txt');
    await writeFile(outsideFile, 'preserve me', 'utf8');

    const registrationPath = runtime.registrationPath(registration.id);
    await fs.promises.symlink(outsideFile, registrationPath);
    await expect(runtime.writeRegistration(registration)).rejects.toMatchObject({
      code: 'symlink_path',
    });
    await expect(runtime.removeRegistration(registration)).rejects.toMatchObject({
      code: 'symlink_path',
    });
    expect(await readFile(outsideFile, 'utf8')).toBe('preserve me');
    expect((await fs.promises.lstat(registrationPath)).isSymbolicLink()).toBe(true);

    await fs.promises.unlink(registrationPath);
    const socketPath = runtime.socketPath(registration.id);
    await fs.promises.symlink(outsideFile, socketPath);
    await expect(runtime.removeSocket(registration.id)).rejects.toMatchObject({
      code: 'symlink_path',
    });
    expect(await readFile(outsideFile, 'utf8')).toBe('preserve me');
    expect((await fs.promises.lstat(socketPath)).isSymbolicLink()).toBe(true);

    await rm(outsideDirectory, { recursive: true, force: true });
  });

  test('does not follow a symlinked runtime root during validation or close', async () => {
    const runtime = await createRuntime();
    const originalRoot = runtime.rootPath;
    const movedRoot = `${originalRoot}-real`;

    await fs.promises.rename(originalRoot, movedRoot);
    await fs.promises.symlink(movedRoot, originalRoot);
    try {
      await expect(
        runtime.validateSocketPath(path.join(runtime.socketsDirectory, 'missing.sock'), {
          allowMissing: true,
        })
      ).rejects.toMatchObject({ code: 'symlink_path' });

      await runtime.close();
      expect((await fs.promises.lstat(originalRoot)).isSymbolicLink()).toBe(true);
      expect((await fs.promises.lstat(movedRoot)).isDirectory()).toBe(true);
    } finally {
      await fs.promises.unlink(originalRoot).catch(() => undefined);
      await rm(movedRoot, { recursive: true, force: true });
    }
  });

  test('rejects outside and redirected registration socket paths before publication', async () => {
    const runtime = await createRuntime();
    const registration = subagentRegistration(runtime);
    const outsidePath = path.join(os.tmpdir(), 'agent-mailbox-outside.sock');

    await expect(
      runtime.writeRegistration({ ...registration, socketPath: outsidePath })
    ).rejects.toThrow(AgentMessagingRuntimeDirectoryError);
    expect(fs.existsSync(runtime.registrationPath(registration.id))).toBe(false);
  });

  test('cleans temporary registration files when publication fails', async () => {
    const runtime = await createRuntime();
    const registration = subagentRegistration(runtime);
    const registrationPath = runtime.registrationPath(registration.id);

    await fs.promises.mkdir(registrationPath);
    await expect(runtime.writeRegistration(registration)).rejects.toMatchObject({
      code: 'unexpected_path_entry',
    });

    const names = await readdir(runtime.agentsDirectory);
    expect(names).toEqual(['worker-id.json']);
    expect((await fs.promises.lstat(registrationPath)).isDirectory()).toBe(true);
    expect(names.some((name) => name.includes('.tmp.'))).toBe(false);
  });

  test('removes registrations and sockets idempotently', async () => {
    const runtime = await createRuntime();
    const registration = subagentRegistration(runtime);
    const socketPath = runtime.socketPath(registration.id);
    const socket = createServer();

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.listen(socketPath, () => resolve());
    });

    await runtime.writeRegistration(registration, { requireSocket: true });
    await runtime.removeRegistration(registration);
    await runtime.removeRegistration(registration);
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    await runtime.removeSocket(registration.id);
    await runtime.removeSocket(registration.id);

    expect(fs.existsSync(runtime.registrationPath(registration.id))).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  test('emergency cleanup removes only the exact created root', async () => {
    const runtime = await createRuntime();
    const sibling = await mkdtemp(path.join(os.tmpdir(), 'tm-sibling-'));
    const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), 'tm-agent-outside-'));
    const outsideFile = path.join(outsideDirectory, 'outside.txt');
    await writeFile(outsideFile, 'preserve me', 'utf8');
    await fs.promises.symlink(outsideDirectory, path.join(runtime.rootPath, 'outside-link'));
    const rootPath = runtime.rootPath;

    CleanupRegistry.getInstance().executeAll();

    expect(fs.existsSync(rootPath)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
    expect(fs.existsSync(outsideFile)).toBe(true);
    await rm(sibling, { recursive: true, force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
  });

  test('normal close is awaited, idempotent, and removes only its exact root', async () => {
    const cleanupRegistry = CleanupRegistry.getInstance();
    const handlersBeforeRuntime = cleanupRegistry.size;
    const runtime = await createRuntime();
    const sibling = await mkdtemp(path.join(os.tmpdir(), 'tm-sibling-'));
    const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), 'tm-agent-outside-'));
    const outsideFile = path.join(outsideDirectory, 'outside.txt');
    await writeFile(outsideFile, 'preserve me', 'utf8');
    await fs.promises.symlink(outsideDirectory, path.join(runtime.rootPath, 'outside-link'));
    const rootPath = runtime.rootPath;
    expect(cleanupRegistry.size).toBe(handlersBeforeRuntime + 1);

    const closes = Array.from({ length: 8 }, () => runtime.close());
    expect(new Set(closes).size).toBe(1);
    await Promise.all(closes);
    await runtime.close();

    expect(fs.existsSync(rootPath)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
    expect(fs.existsSync(outsideFile)).toBe(true);
    expect(cleanupRegistry.size).toBe(handlersBeforeRuntime);
    await rm(sibling, { recursive: true, force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
    await expect(runtime.readRegistration('worker-id')).rejects.toMatchObject({
      code: 'runtime_closed',
    });
  });
});
