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
  MAX_UNIX_SOCKET_PATH_BYTES,
  REGISTRATION_FILE_MODE,
  RUNTIME_DIRECTORY_MODE,
  AgentMessagingRuntimeDirectoryError,
  createAgentMessagingRuntimeDirectory,
  isStrictPathDescendant,
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
    await expect(runtime.writeRegistration(registration)).rejects.toThrow();

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
    const rootPath = runtime.rootPath;

    CleanupRegistry.getInstance().executeAll();

    expect(fs.existsSync(rootPath)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
    await rm(sibling, { recursive: true, force: true });
  });

  test('normal close is awaited, idempotent, and removes only its exact root', async () => {
    const runtime = await createRuntime();
    const sibling = await mkdtemp(path.join(os.tmpdir(), 'tm-sibling-'));
    const rootPath = runtime.rootPath;

    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(firstClose).toBe(secondClose);
    await Promise.all([firstClose, secondClose]);
    await runtime.close();

    expect(fs.existsSync(rootPath)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
    await rm(sibling, { recursive: true, force: true });
    await expect(runtime.readRegistration('worker-id')).rejects.toMatchObject({
      code: 'runtime_closed',
    });
  });
});
