import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { TimConfig } from '$tim/configSchema.js';
import { runMigrations } from '$tim/db/migrations.js';
import { createSyncRunner, startSyncSequenceRetentionRunner } from '$tim/sync/runner.js';

import { startSyncService, type SyncServiceHandle } from './sync_service.js';

const runnerMock = vi.hoisted(() => {
  const status = {
    running: false,
    inProgress: false,
    connected: false,
    lastKnownSequenceId: 0,
    pendingOperationCount: 0,
  };
  const retentionRunner = {
    stop: vi.fn(),
    runOnce: vi.fn(() => 0),
  };
  const runner = {
    start: vi.fn(() => {
      status.running = true;
    }),
    stop: vi.fn(() => {
      status.running = false;
    }),
    runOnce: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({ ...status })),
  };
  return { runner, status, retentionRunner };
});

vi.mock('$tim/sync/runner.js', async () => {
  const actual = await vi.importActual<typeof import('$tim/sync/runner.js')>('$tim/sync/runner.js');
  return {
    ...actual,
    createSyncRunner: vi.fn(() => runnerMock.runner),
    startSyncSequenceRetentionRunner: vi.fn(() => runnerMock.retentionRunner),
  };
});

const handles: SyncServiceHandle[] = [];
const dbs: Database[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.stop();
  }
  for (const db of dbs.splice(0)) {
    db.close();
  }
  runnerMock.status.running = false;
  vi.restoreAllMocks();
  vi.mocked(createSyncRunner).mockClear();
  vi.mocked(startSyncSequenceRetentionRunner).mockClear();
  runnerMock.runner.start.mockClear();
  runnerMock.runner.stop.mockClear();
  runnerMock.runner.runOnce.mockClear();
  runnerMock.runner.getStatus.mockClear();
  runnerMock.retentionRunner.stop.mockClear();
  runnerMock.retentionRunner.runOnce.mockClear();
});

describe('sync service lifecycle', () => {
  test('returns null when sync is explicitly disabled', async () => {
    const handle = await startSyncService(createDb(), config({ disabled: true }));

    expect(handle).toBeNull();
  });

  test('returns null when sync config is missing, invalid, or ephemeral', async () => {
    await expect(startSyncService(createDb(), config())).resolves.toBeNull();
    await expect(startSyncService(createDb(), config({ role: 'persistent' }))).resolves.toBeNull();
    await expect(
      startSyncService(createDb(), config({ role: 'ephemeral', nodeId: 'worker-node' }))
    ).resolves.toBeNull();
  });

  test('starts and stops a main-node sync server with minimal valid config', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = await startSyncService(
      createDb(),
      config({ role: 'main', nodeId: 'main-node' })
    );
    expect(handle).not.toBeNull();
    handles.push(handle!);

    expect(handle!.role).toBe('main');
    expect(handle).toMatchObject({ hostname: '127.0.0.1' });
    const port = handle!.role === 'main' ? handle!.port : 0;
    expect(port).toBeGreaterThan(0);

    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).resolves.toMatchObject({
      ok: true,
      status: 200,
    });

    handle!.stop();
    handle!.stop();
    handles.pop();

    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  test('passes configured main-node bind options and defaults loopback to insecure transport', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const handle = await startSyncService(
      createDb(),
      config({
        role: 'main',
        nodeId: 'main-node',
        serverHost: '127.0.0.1',
        serverPort: 0,
      })
    );
    expect(handle).not.toBeNull();
    handles.push(handle!);

    expect(handle).toMatchObject({ role: 'main', hostname: '127.0.0.1' });
  });

  test('defaults non-loopback main-node bind to require secure transport', async () => {
    const serverModule = await import('$tim/sync/server.js');
    const startSyncServerSpy = vi.spyOn(serverModule, 'startSyncServer').mockReturnValue({
      port: 8124,
      hostname: '0.0.0.0',
      stop: vi.fn(),
      broadcast: vi.fn(),
      connections: new Map(),
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const handle = await startSyncService(
      createDb(),
      config({
        role: 'main',
        nodeId: 'main-node',
        serverHost: '0.0.0.0',
        serverPort: 8124,
      })
    );
    expect(handle).not.toBeNull();
    handles.push(handle!);

    expect(startSyncServerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: '0.0.0.0',
        port: 8124,
        requireSecureTransport: true,
      })
    );
  });

  test('honors explicit requireSecureTransport for main-node bind', async () => {
    const serverModule = await import('$tim/sync/server.js');
    const startSyncServerSpy = vi.spyOn(serverModule, 'startSyncServer').mockReturnValue({
      port: 8125,
      hostname: '127.0.0.1',
      stop: vi.fn(),
      broadcast: vi.fn(),
      connections: new Map(),
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const handle = await startSyncService(
      createDb(),
      config({
        role: 'main',
        nodeId: 'main-node',
        serverHost: '127.0.0.1',
        serverPort: 8125,
        requireSecureTransport: true,
      })
    );
    expect(handle).not.toBeNull();
    handles.push(handle!);

    expect(startSyncServerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requireSecureTransport: true })
    );
  });

  test('returns null for persistent offline mode without creating a runner', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const handle = await startSyncService(
      createDb(),
      config({
        role: 'persistent',
        nodeId: 'persistent-node',
        mainUrl: 'http://127.0.0.1:9',
        nodeToken: 'token',
        offline: true,
      })
    );

    expect(handle).toBeNull();
    expect(createSyncRunner).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith('[sync] offline mode (persistent runner not started)');
  });

  test('starts and stops a persistent-node runner without blocking on connection', async () => {
    const handle = await startSyncService(
      createDb(),
      config({
        role: 'persistent',
        nodeId: 'persistent-node',
        mainUrl: 'http://127.0.0.1:9',
        nodeToken: 'token',
      })
    );
    expect(handle).not.toBeNull();
    handles.push(handle!);
    expect(handle!.role).toBe('persistent');
    expect(createSyncRunner).toHaveBeenCalledTimes(1);
    expect(runnerMock.runner.getStatus().running).toBe(true);

    handle!.stop();
    handle!.stop();
    handles.pop();
    expect(runnerMock.runner.stop).toHaveBeenCalledTimes(1);
    expect(runnerMock.runner.getStatus().running).toBe(false);
  });

  test('starts the sequence retention runner for main node and stops it with the handle', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = await startSyncService(
      createDb(),
      config({ role: 'main', nodeId: 'main-node' })
    );
    expect(handle).not.toBeNull();
    handles.push(handle!);

    expect(startSyncSequenceRetentionRunner).toHaveBeenCalledTimes(1);

    handle!.stop();
    handles.pop();
    expect(runnerMock.retentionRunner.stop).toHaveBeenCalledTimes(1);
  });

  test('does NOT start the sequence retention runner for persistent nodes', async () => {
    const handle = await startSyncService(
      createDb(),
      config({
        role: 'persistent',
        nodeId: 'persistent-node',
        mainUrl: 'http://127.0.0.1:9',
        nodeToken: 'token',
      })
    );
    expect(handle).not.toBeNull();
    handles.push(handle!);

    expect(startSyncSequenceRetentionRunner).not.toHaveBeenCalled();
  });
});

function createDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  dbs.push(db);
  return db;
}

function config(sync: TimConfig['sync'] = {}): TimConfig {
  return { sync } as TimConfig;
}
