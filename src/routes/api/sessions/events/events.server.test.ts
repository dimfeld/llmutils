import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';

import { SessionManager } from '$lib/server/session_manager.js';

let currentManager: SessionManager;

vi.mock('$lib/server/session_context.js', () => ({
  getSessionManager: () => currentManager,
}));

describe('/api/sessions/events', () => {
  let tempDir: string;
  let db: Database;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sessions-events-route-test-'));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T10:00:00.000Z'));

    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    currentManager = new SessionManager(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('GET streams the current session snapshot', async () => {
    currentManager.handleHttpNotification({
      gitRemote: 'git@example.com:repo.git',
      message: 'hello',
      workspacePath: '/tmp/repo',
    });

    const abortController = new AbortController();
    const { GET } = await import('./+server.js');
    const response = await GET({
      request: new Request('http://localhost/api/sessions/events', {
        signal: abortController.signal,
      }),
    } as never);

    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const chunk = await response.body!.getReader().read();
    const payload = new TextDecoder().decode(chunk.value);

    expect(chunk.done).toBe(false);
    expect(payload).toContain('event: session:list\n');
    expect(payload).toContain(
      '"sessions":[{"connectionId":"notification:example.com/repo|/tmp/repo"'
    );

    abortController.abort();
  });
});
