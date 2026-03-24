import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getTimSessionDir,
  listSessionInfoFiles,
  readSessionInfoFile,
  registerSessionInfoFileCleanup,
  removeSessionInfoFile,
  unregisterSessionInfoFileCleanup,
  writeSessionInfoFile,
  type SessionInfoFile,
} from './runtime_dir.js';

describe('session_server/runtime_dir', () => {
  const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
  const trackedPids = new Set<number>();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'tim-session-runtime-test-'));
    process.env.XDG_CACHE_HOME = tempDir;
  });

  afterEach(async () => {
    for (const pid of trackedPids) {
      unregisterSessionInfoFileCleanup(pid);
      removeSessionInfoFile(pid);
    }
    trackedPids.clear();

    if (originalXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  function createInfo(overrides: Partial<SessionInfoFile> = {}): SessionInfoFile {
    const info: SessionInfoFile = {
      sessionId: 'session-1',
      pid: overrides.pid ?? 41001,
      port: 9123,
      hostname: '127.0.0.1',
      command: 'agent',
      workspacePath: '/tmp/workspace',
      planId: 222,
      planUuid: 'plan-uuid-222',
      planTitle: 'tim runs websocket server',
      gitRemote: 'github.com/owner/repo',
      startedAt: '2026-03-23T00:00:00.000Z',
      token: true,
      ...overrides,
    };
    trackedPids.add(info.pid);
    return info;
  }

  test('creates the session directory inside the tim cache directory', () => {
    const sessionDir = getTimSessionDir();

    expect(sessionDir).toBe(path.join(tempDir, 'tim', 'sessions'));
    expect(fs.existsSync(sessionDir)).toBe(true);

    if (process.platform !== 'win32') {
      const mode = fs.statSync(sessionDir).mode & 0o777;
      expect(mode).toBe(0o700);
    }
  });

  test('writes, reads, lists, and removes session info files', () => {
    const infoA = createInfo({ pid: 41011, sessionId: 'session-a', port: 9001 });
    const infoB = createInfo({ pid: 41012, sessionId: 'session-b', port: 9002 });

    const filePath = writeSessionInfoFile(infoA);
    writeSessionInfoFile(infoB);

    expect(path.basename(filePath)).toBe('41011.json');
    expect(readSessionInfoFile(41011)).toEqual(infoA);
    expect(readSessionInfoFile(filePath)).toEqual(infoA);
    expect(listSessionInfoFiles()).toEqual([infoA, infoB]);

    removeSessionInfoFile(41011);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(listSessionInfoFiles()).toEqual([infoB]);
  });

  test('rewriting a session file keeps the file valid for readers', () => {
    const pid = 41021;
    const initial = createInfo({ pid, sessionId: 'session-initial', port: 7001 });
    const updated = createInfo({ pid, sessionId: 'session-updated', port: 7002 });

    writeSessionInfoFile(initial);
    writeSessionInfoFile(updated);

    expect(readSessionInfoFile(pid)).toEqual(updated);
    expect(listSessionInfoFiles()).toEqual([updated]);
  });

  test('listSessionInfoFiles ignores malformed json files', () => {
    const info = createInfo({ pid: 41031 });
    writeSessionInfoFile(info);

    fs.writeFileSync(path.join(getTimSessionDir(), 'bad.json'), '{not valid json', 'utf8');
    fs.writeFileSync(
      path.join(getTimSessionDir(), 'missing-fields.json'),
      JSON.stringify({ sessionId: 'broken', pid: 1234 }),
      'utf8'
    );
    fs.mkdirSync(path.join(getTimSessionDir(), 'not-a-json-file'));

    expect(listSessionInfoFiles()).toEqual([info]);
  });

  test('readSessionInfoFile rejects invalid planUuid values and listSessionInfoFiles ignores them', () => {
    const info = createInfo({ pid: 41032, sessionId: 'valid-session' });
    writeSessionInfoFile(info);

    const invalidPath = path.join(getTimSessionDir(), 'invalid-plan-uuid.json');
    fs.writeFileSync(
      invalidPath,
      JSON.stringify({
        ...info,
        pid: 41033,
        sessionId: 'invalid-plan-uuid',
        planUuid: 123,
      }),
      'utf8'
    );

    expect(() => readSessionInfoFile(invalidPath)).toThrow('invalid planUuid');
    expect(listSessionInfoFiles()).toEqual([info]);
  });

  test('readSessionInfoFile rejects invalid hostname values and listSessionInfoFiles ignores them', () => {
    const info = createInfo({ pid: 41034, sessionId: 'valid-hostname' });
    writeSessionInfoFile(info);

    const invalidPath = path.join(getTimSessionDir(), 'invalid-hostname.json');
    fs.writeFileSync(
      invalidPath,
      JSON.stringify({
        ...info,
        pid: 41036,
        sessionId: 'invalid-hostname',
        hostname: 123,
      }),
      'utf8'
    );

    expect(() => readSessionInfoFile(invalidPath)).toThrow('invalid hostname');
    expect(listSessionInfoFiles()).toEqual([info]);
  });

  test('readSessionInfoFile rejects pid 0 and listSessionInfoFiles ignores it', () => {
    const info = createInfo({ pid: 41037, sessionId: 'valid-pid' });
    writeSessionInfoFile(info);

    const invalidPath = path.join(getTimSessionDir(), 'invalid-pid.json');
    fs.writeFileSync(
      invalidPath,
      JSON.stringify({
        ...info,
        pid: 0,
        sessionId: 'invalid-pid',
      }),
      'utf8'
    );

    expect(() => readSessionInfoFile(invalidPath)).toThrow('invalid pid');
    expect(listSessionInfoFiles()).toEqual([info]);
  });

  test('keeps stale session files readable even when the pid is not alive', () => {
    const staleInfo = createInfo({ pid: 999_999_999, sessionId: 'stale-session' });
    writeSessionInfoFile(staleInfo);

    expect(readSessionInfoFile(staleInfo.pid)).toEqual(staleInfo);
    expect(listSessionInfoFiles()).toEqual([staleInfo]);
  });

  test('preserves valid json during overlapping writes for the same pid', async () => {
    const pid = 41035;
    const versions = Array.from({ length: 10 }, (_, index) =>
      createInfo({
        pid,
        sessionId: `session-${index}`,
        port: 9200 + index,
        startedAt: `2026-03-23T00:00:${String(index).padStart(2, '0')}.000Z`,
      })
    );

    await Promise.all(
      versions.map(
        (info, index) =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              writeSessionInfoFile(info);
              resolve();
            }, index % 3);
          })
      )
    );

    const finalInfo = readSessionInfoFile(pid);
    expect(versions).toContainEqual(finalInfo);
    expect(() =>
      JSON.parse(fs.readFileSync(path.join(getTimSessionDir(), `${pid}.json`), 'utf8'))
    ).not.toThrow();
    expect(listSessionInfoFiles()).toEqual([finalInfo]);
  });

  test('exit cleanup removes file and unregisters handler', () => {
    const info = createInfo({ pid: 41041 });
    const sessionDir = getTimSessionDir();

    writeSessionInfoFile(info);

    const beforeExitCount = process.listeners('exit').length;

    registerSessionInfoFileCleanup(info.pid);

    // Handler was registered (writeSessionInfoFile already registers, so count stays same
    // since registerSessionInfoFileCleanup deduplicates)
    expect(process.listeners('exit').length).toBe(beforeExitCount);

    // Simulate exit handler firing
    const exitHandler = process.listeners('exit').at(-1) as () => void;
    exitHandler();

    // File should be removed
    expect(fs.existsSync(path.join(sessionDir, `${info.pid}.json`))).toBe(false);

    // Handler should be unregistered
    expect(process.listeners('exit').length).toBe(beforeExitCount - 1);
  });

  test('unregisterSessionInfoFileCleanup removes exit handler', () => {
    const info = createInfo({ pid: 41042 });
    writeSessionInfoFile(info);

    const beforeExitCount = process.listeners('exit').length;

    // writeSessionInfoFile already registers cleanup; verify handler exists
    expect(process.listeners('exit').length).toBe(beforeExitCount);

    // Manually unregister
    unregisterSessionInfoFileCleanup(info.pid);

    expect(process.listeners('exit').length).toBe(beforeExitCount - 1);

    // File should still exist (cleanup wasn't triggered, just handler removed)
    expect(fs.existsSync(path.join(getTimSessionDir(), `${info.pid}.json`))).toBe(true);
  });
});
