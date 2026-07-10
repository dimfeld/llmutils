import type { Database } from 'bun:sqlite';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getArtifactByUuid, insertArtifact } from '$tim/db/artifact.js';
import {
  upsertCanonicalPlanInTransaction,
  upsertProjectionPlanInTransaction,
} from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';
import type { TimConfig } from '$tim/configSchema.js';
import { invokeCommand } from '$lib/test-utils/invoke_command.js';

let currentDb: Database;
let currentConfig: TimConfig;
let tempDir: string;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: currentConfig,
    db: currentDb,
  }),
}));

import {
  softDeleteArtifact,
  restoreArtifact,
  hardDeleteArtifact,
} from './artifact_actions.remote.js';

const PROJECT_UUID = 'cccccccc-1111-4111-8111-111111111111';
const PLAN_UUID = 'dddddddd-2222-4222-8222-222222222222';

function makeArtifact(uuid: string, overrides: Partial<Parameters<typeof insertArtifact>[1]> = {}) {
  return insertArtifact(currentDb, {
    uuid,
    planUuid: PLAN_UUID,
    projectUuid: PROJECT_UUID,
    filename: 'artifact.txt',
    mimeType: 'text/plain',
    size: 4,
    sha256: 'testsha256',
    storagePath: path.join(tempDir, 'missing', uuid, 'artifact.txt'),
    ...overrides,
  });
}

describe('artifact remote actions', () => {
  let savedXdgDataHome: string | undefined;

  beforeAll(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tim-artifact-remote-test-'));
  });

  beforeEach(() => {
    savedXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(tempDir, 'data');

    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    currentConfig = { sync: { nodeId: '00000000-0000-4000-8000-000000000001' } };

    const project = getOrCreateProject(currentDb, 'repo-artifact-remote', {
      uuid: PROJECT_UUID,
      remoteUrl: 'https://example.com/repo.git',
      lastGitRoot: tempDir,
    });

    const plan = {
      uuid: PLAN_UUID,
      planId: 1,
      title: 'Remote test plan',
      status: 'pending' as const,
      revision: 1,
      forceOverwrite: true,
    };
    upsertCanonicalPlanInTransaction(currentDb, project.id, plan);
    upsertProjectionPlanInTransaction(currentDb, project.id, plan);
  });

  afterEach(() => {
    currentDb.close(false);
    if (savedXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = savedXdgDataHome;
    }
  });

  afterAll(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  function sequenceCount(): number {
    return (
      currentDb.prepare('SELECT COUNT(*) AS count FROM sync_sequence').get() as { count: number }
    ).count;
  }

  describe('softDeleteArtifact', () => {
    test('sets deleted_at on an active artifact', async () => {
      const uuid = '10000000-aaaa-4000-8000-000000000001';
      makeArtifact(uuid);

      const result = await invokeCommand(softDeleteArtifact, { uuid });

      expect(result.changed).toBe(true);
      expect(result.artifact.deletedAt).toBeTruthy();
      const row = getArtifactByUuid(currentDb, uuid);
      expect(row?.deletedAt).toBeTruthy();
    });

    test('returns updated artifact row', async () => {
      const uuid = '10000000-aaaa-4000-8000-000000000002';
      makeArtifact(uuid, { filename: 'report.txt', mimeType: 'text/plain' });

      const result = await invokeCommand(softDeleteArtifact, { uuid });

      expect(result.artifact.uuid).toBe(uuid);
      expect(result.artifact.filename).toBe('report.txt');
    });

    test('is idempotent: second soft-delete does not error', async () => {
      const uuid = '10000000-aaaa-4000-8000-000000000003';
      makeArtifact(uuid, { deletedAt: '2026-01-01T00:00:00.000Z' });

      // Already soft-deleted — should not throw
      const result = await invokeCommand(softDeleteArtifact, { uuid });
      expect(result.changed).toBe(false);
      expect(result.artifact.deletedAt).toBeTruthy();
    });

    test('returns 404 for unknown UUID', async () => {
      await expect(
        invokeCommand(softDeleteArtifact, { uuid: '00000000-0000-4000-8000-000000000000' })
      ).rejects.toMatchObject({ status: 404 });
    });

    test('emits a sync_sequence entry (write-router was invoked)', async () => {
      const uuid = '10000000-aaaa-4000-8000-000000000004';
      makeArtifact(uuid);

      const seqBefore = sequenceCount();
      await invokeCommand(softDeleteArtifact, { uuid });
      expect(sequenceCount()).toBeGreaterThan(seqBefore);
    });
  });

  describe('restoreArtifact', () => {
    test('clears deleted_at on a soft-deleted artifact', async () => {
      const uuid = '20000000-aaaa-4000-8000-000000000001';
      makeArtifact(uuid, { deletedAt: '2026-01-01T00:00:00.000Z' });

      const result = await invokeCommand(restoreArtifact, { uuid });

      expect(result.changed).toBe(true);
      expect(result.artifact.deletedAt).toBeNull();
      const row = getArtifactByUuid(currentDb, uuid);
      expect(row?.deletedAt).toBeNull();
    });

    test('is idempotent: restoring an already-active artifact does not error', async () => {
      const uuid = '20000000-aaaa-4000-8000-000000000002';
      makeArtifact(uuid); // already active (no deletedAt)

      const result = await invokeCommand(restoreArtifact, { uuid });
      expect(result.changed).toBe(false);
      expect(result.artifact.deletedAt).toBeNull();
    });

    test('returns 404 for unknown UUID', async () => {
      await expect(
        invokeCommand(restoreArtifact, { uuid: '00000000-0000-4000-8000-000000000000' })
      ).rejects.toMatchObject({ status: 404 });
    });

    test('emits a sync_sequence entry', async () => {
      const uuid = '20000000-aaaa-4000-8000-000000000003';
      makeArtifact(uuid, { deletedAt: '2026-01-01T00:00:00.000Z' });

      const seqBefore = sequenceCount();
      await invokeCommand(restoreArtifact, { uuid });
      expect(sequenceCount()).toBeGreaterThan(seqBefore);
    });
  });

  describe('hardDeleteArtifact', () => {
    test('removes the DB row', async () => {
      const uuid = '30000000-aaaa-4000-8000-000000000001';
      makeArtifact(uuid);

      await invokeCommand(hardDeleteArtifact, { uuid });

      expect(getArtifactByUuid(currentDb, uuid)).toBeUndefined();
    });

    test('returns { changed: true } when row existed', async () => {
      const uuid = '30000000-aaaa-4000-8000-000000000002';
      makeArtifact(uuid);

      const result = await invokeCommand(hardDeleteArtifact, { uuid });
      expect(result.changed).toBe(true);
    });

    test('removes the on-disk file when it exists', async () => {
      const filePath = path.join(tempDir, 'to-delete.txt');
      await fsp.writeFile(filePath, 'content');

      const uuid = '30000000-aaaa-4000-8000-000000000003';
      makeArtifact(uuid, { storagePath: filePath });

      await invokeCommand(hardDeleteArtifact, { uuid });

      await expect(fsp.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('returns 404 for unknown UUID', async () => {
      await expect(
        invokeCommand(hardDeleteArtifact, { uuid: '00000000-0000-4000-8000-000000000000' })
      ).rejects.toMatchObject({ status: 404 });
    });

    test('emits a sync_sequence entry', async () => {
      const uuid = '30000000-aaaa-4000-8000-000000000004';
      makeArtifact(uuid);

      const seqBefore = sequenceCount();
      await invokeCommand(hardDeleteArtifact, { uuid });
      expect(sequenceCount()).toBeGreaterThan(seqBefore);
    });

    test('does not remove storagePath when file is absent (idempotent unlink)', async () => {
      const uuid = '30000000-aaaa-4000-8000-000000000005';
      makeArtifact(uuid, { storagePath: '/nonexistent/already-gone.txt' });

      // Should not throw even though the file is absent
      const result = await invokeCommand(hardDeleteArtifact, { uuid });
      expect(result.changed).toBe(true);
    });
  });
});
