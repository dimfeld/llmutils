import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    stat: vi.fn(actual.stat),
  };
});

import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { getDefaultConfig } from '../configSchema.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { upsertCanonicalPlanInTransaction, upsertProjectionPlanInTransaction } from '../db/plan.js';
import { getArtifactByUuid, insertArtifact } from '../db/artifact.js';
import {
  markTransferFailed,
  markTransferInProgress,
  markTransferSucceeded,
  upsertPendingTransfer,
} from '../db/artifact_transfer.js';
import { MAX_ARTIFACT_BYTES } from './constants.js';
import { getArtifactsRoot, resolveArtifactPath } from './storage.js';
import {
  addArtifact,
  addArtifactByPlanUuid,
  ArtifactNotFoundError,
  getArtifact,
  hardDeleteArtifact,
  listArtifacts,
  purgeArtifacts,
  restoreArtifact,
  softDeleteArtifact,
} from './service.js';

describe('artifact service', () => {
  let tempDir: string;
  let sourceDir: string;
  let db: Database;
  let projectUuid: string;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-artifact-service-test-'));
    sourceDir = path.join(tempDir, 'source');
    await fs.mkdir(sourceDir, { recursive: true });
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tempDir, 'data');
    closeDatabaseForTesting();
    db = getDatabase();

    const repository = await getRepositoryIdentity({ cwd: tempDir });
    const project = getOrCreateProject(db, repository.repositoryId, {
      remoteUrl: repository.remoteUrl,
      lastGitRoot: tempDir,
    });
    projectUuid = project.uuid;
    const plan = {
      uuid: '11111111-1111-4111-8111-111111111111',
      planId: 1,
      title: 'Artifact service plan',
      status: 'pending',
      revision: 1,
      forceOverwrite: true,
    };
    upsertCanonicalPlanInTransaction(db, project.id, plan);
    upsertProjectionPlanInTransaction(db, project.id, plan);
  });

  afterEach(async () => {
    closeDatabaseForTesting();
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('adds an artifact, stores the file, and lists it', async () => {
    const sourcePath = path.join(sourceDir, 'screenshot.png');
    await fs.writeFile(sourcePath, 'image bytes');

    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      message: 'before fix',
      config: getDefaultConfig(),
      repoRoot: tempDir,
    });

    expect(artifact).toMatchObject({
      planUuid: '11111111-1111-4111-8111-111111111111',
      projectUuid,
      filename: 'screenshot.png',
      mimeType: 'image/png',
      size: 11,
      message: 'before fix',
      deletedAt: null,
    });
    await expect(fs.readFile(artifact.storagePath, 'utf8')).resolves.toBe('image bytes');
    expect(
      await listArtifacts({ planId: 1, config: getDefaultConfig(), repoRoot: tempDir })
    ).toHaveLength(1);
  });

  test('retains a relative subpath as the filename and strips traversal components', async () => {
    const planUuid = '11111111-1111-4111-8111-111111111111';
    const sourcePath = path.join(sourceDir, 'runbook-screenshot.png');
    await fs.writeFile(sourcePath, 'image bytes');

    const grouped = await addArtifactByPlanUuid({
      planUuid,
      sourcePath,
      originalFilename: 'runbook-1/screenshot.png',
      config: getDefaultConfig(),
    });
    expect(grouped.filename).toBe('runbook-1/screenshot.png');

    const traversal = await addArtifactByPlanUuid({
      planUuid,
      sourcePath,
      originalFilename: '../../etc/passwd',
      config: getDefaultConfig(),
    });
    expect(traversal.filename).toBe('etc/passwd');

    const empty = await addArtifactByPlanUuid({
      planUuid,
      sourcePath,
      originalFilename: '../..',
      config: getDefaultConfig(),
    });
    expect(empty.filename).toBe('runbook-screenshot.png');
  });

  test('rejects missing and oversized source files', async () => {
    await expect(
      addArtifact({
        planId: 1,
        sourcePath: path.join(sourceDir, 'missing.txt'),
        config: getDefaultConfig(),
        repoRoot: tempDir,
      })
    ).rejects.toThrow(/does not exist/);

    const largePath = path.join(sourceDir, 'large.bin');
    const file = await fs.open(largePath, 'w');
    try {
      await file.truncate(MAX_ARTIFACT_BYTES + 1);
    } finally {
      await file.close();
    }
    await expect(
      addArtifact({
        planId: 1,
        sourcePath: largePath,
        config: getDefaultConfig(),
        repoRoot: tempDir,
      })
    ).rejects.toThrow(/too large/);
  });

  test('resolves symlink source paths and rejects dangling symlinks as missing', async () => {
    const targetPath = path.join(sourceDir, 'target.log');
    const symlinkPath = path.join(sourceDir, 'source-link.log');
    await fs.writeFile(targetPath, 'target bytes');
    await fs.symlink(targetPath, symlinkPath);

    const artifact = await addArtifact({
      planId: 1,
      sourcePath: symlinkPath,
      config: getDefaultConfig(),
      repoRoot: tempDir,
    });

    expect(artifact.filename).toBe('target.log');
    await expect(fs.readFile(artifact.storagePath, 'utf8')).resolves.toBe('target bytes');

    const danglingPath = path.join(sourceDir, 'dangling-link.log');
    await fs.symlink(path.join(sourceDir, 'missing-target.log'), danglingPath);
    await expect(
      addArtifact({
        planId: 1,
        sourcePath: danglingPath,
        config: getDefaultConfig(),
        repoRoot: tempDir,
      })
    ).rejects.toThrow(/does not exist/);
  });

  test('gets, soft-deletes, restores, and hard-deletes artifacts', async () => {
    const sourcePath = path.join(sourceDir, 'output.log');
    await fs.writeFile(sourcePath, 'log');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: tempDir,
    });

    expect(getArtifact(artifact.uuid).uuid).toBe(artifact.uuid);
    await expect(() => getArtifact('00000000-0000-4000-8000-000000000000')).toThrow(
      ArtifactNotFoundError
    );

    const deleted = await softDeleteArtifact(artifact.uuid, { config: getDefaultConfig() });
    expect(deleted.changed).toBe(true);
    expect(deleted.artifact.deletedAt).toBeTruthy();
    expect(
      await listArtifacts({ planId: 1, config: getDefaultConfig(), repoRoot: tempDir })
    ).toEqual([]);
    expect(
      await listArtifacts({
        planId: 1,
        includeDeleted: true,
        config: getDefaultConfig(),
        repoRoot: tempDir,
      })
    ).toHaveLength(1);
    expect((await softDeleteArtifact(artifact.uuid, { config: getDefaultConfig() })).changed).toBe(
      false
    );

    const restored = await restoreArtifact(artifact.uuid, { config: getDefaultConfig() });
    expect(restored.changed).toBe(true);
    expect(restored.artifact.deletedAt).toBeNull();
    expect((await restoreArtifact(artifact.uuid, { config: getDefaultConfig() })).changed).toBe(
      false
    );

    const hardDeleted = await hardDeleteArtifact(artifact.uuid, { config: getDefaultConfig() });
    expect(hardDeleted.changed).toBe(true);
    expect(getArtifactByUuid(db, artifact.uuid)).toBeUndefined();
    await expect(fs.stat(artifact.storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await hardDeleteArtifact(artifact.uuid, { config: getDefaultConfig() })).changed).toBe(
      false
    );
  });

  test('purges old soft-deleted, completed-plan, and orphan artifacts', async () => {
    const softDeletedPath = path.join(sourceDir, 'soft.txt');
    const completedPath = path.join(sourceDir, 'completed.txt');
    await fs.writeFile(softDeletedPath, 'soft');
    await fs.writeFile(completedPath, 'completed');
    const softDeleted = await addArtifact({
      planId: 1,
      sourcePath: softDeletedPath,
      config: getDefaultConfig(),
      repoRoot: tempDir,
    });
    const completed = await addArtifact({
      planId: 1,
      sourcePath: completedPath,
      config: getDefaultConfig(),
      repoRoot: tempDir,
    });
    await softDeleteArtifact(softDeleted.uuid, { config: getDefaultConfig() });
    db.prepare(
      "UPDATE plan_artifact SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE uuid = ?"
    ).run(softDeleted.uuid);
    db.prepare(
      "UPDATE plan SET status = 'done', updated_at = '2026-01-01T00:00:00.000Z' WHERE uuid = ?"
    ).run(completed.planUuid);

    const orphanDir = path.dirname(
      resolveArtifactPath(projectUuid, completed.planUuid, 'orphan-artifact', '.txt')
    );
    await fs.mkdir(orphanDir, { recursive: true });
    const oldOrphan = path.join(orphanDir, 'orphan-artifact.txt');
    const freshOrphan = path.join(orphanDir, 'fresh-orphan.txt');
    await fs.writeFile(oldOrphan, 'orphan');
    await fs.writeFile(freshOrphan, 'fresh');
    const oldTime = new Date(Date.now() - 120_000);
    await fs.utimes(oldOrphan, oldTime, oldTime);

    const dryRun = await purgeArtifacts({
      olderThanDays: 30,
      dryRun: true,
      config: getDefaultConfig(),
    });
    expect(dryRun).toMatchObject({
      softDeletedRowsHardDeleted: 1,
      completedPlanRowsHardDeleted: 1,
      orphanFilesRemoved: 1,
      dryRun: true,
    });
    expect(getArtifactByUuid(db, softDeleted.uuid)).toBeDefined();
    await expect(fs.stat(oldOrphan)).resolves.toBeDefined();

    const report = await purgeArtifacts({
      olderThanDays: 30,
      config: getDefaultConfig(),
    });
    expect(report).toMatchObject({
      softDeletedRowsHardDeleted: 1,
      completedPlanRowsHardDeleted: 1,
      orphanFilesRemoved: 1,
      dryRun: false,
    });
    expect(report.bytesReclaimed).toBeGreaterThanOrEqual('softcompletedorphan'.length);
    expect(getArtifactByUuid(db, softDeleted.uuid)).toBeUndefined();
    expect(getArtifactByUuid(db, completed.uuid)).toBeUndefined();
    await expect(fs.stat(oldOrphan)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(freshOrphan)).resolves.toBeDefined();
  });

  test('purge skips missing artifact root', async () => {
    await fs.rm(getArtifactsRoot(), { recursive: true, force: true });
    await expect(purgeArtifacts({ config: getDefaultConfig() })).resolves.toMatchObject({
      orphanFilesRemoved: 0,
    });
  });

  test('purge skips orphan files unlinked between directory walk and stat', async () => {
    const orphanDir = path.dirname(
      resolveArtifactPath(projectUuid, '11111111-1111-4111-8111-111111111111', 'race', '.txt')
    );
    await fs.mkdir(orphanDir, { recursive: true });
    const orphanPath = path.join(orphanDir, 'race.txt');
    await fs.writeFile(orphanPath, 'race');

    const enoent = Object.assign(new Error('missing during stat'), { code: 'ENOENT' });
    vi.mocked(fs.stat).mockRejectedValueOnce(enoent);
    try {
      await expect(purgeArtifacts({ config: getDefaultConfig() })).resolves.toMatchObject({
        orphanFilesRemoved: 0,
      });
    } finally {
      vi.mocked(fs.stat).mockClear();
    }
  });

  test('purge hard-deletes file-missing rows without counting missing bytes', async () => {
    const sourcePath = path.join(sourceDir, 'missing-purge.txt');
    await fs.writeFile(sourcePath, 'missing bytes');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: tempDir,
    });
    await softDeleteArtifact(artifact.uuid, { config: getDefaultConfig() });
    db.prepare(
      "UPDATE plan_artifact SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE uuid = ?"
    ).run(artifact.uuid);
    await fs.rm(artifact.storagePath, { force: true });

    const dryRun = await purgeArtifacts({
      olderThanDays: 30,
      dryRun: true,
      config: getDefaultConfig(),
    });
    expect(dryRun).toMatchObject({
      softDeletedRowsHardDeleted: 1,
      bytesReclaimed: 0,
    });

    const report = await purgeArtifacts({ olderThanDays: 30, config: getDefaultConfig() });
    expect(report).toMatchObject({
      softDeletedRowsHardDeleted: 1,
      bytesReclaimed: 0,
    });
    expect(getArtifactByUuid(db, artifact.uuid)).toBeUndefined();
  });

  test('listArtifacts includes transfer state from artifact_transfer table', async () => {
    const sourcePath = path.join(sourceDir, 'xfer.txt');
    await fs.writeFile(sourcePath, 'xfer');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      message: undefined,
      config: getDefaultConfig(),
      repoRoot: tempDir,
    });

    // No transfer row and file present => transferState null
    let results = await listArtifacts({ planId: 1, config: getDefaultConfig(), repoRoot: tempDir });
    expect(results[0].transferState).toBeNull();

    // Pending upload row => transferState 'pending'
    upsertPendingTransfer(db, artifact.uuid, 'remote-node', 'upload');
    results = await listArtifacts({ planId: 1, config: getDefaultConfig(), repoRoot: tempDir });
    expect(results[0].transferState).toBe('pending');
  });

  test('listArtifacts reports the worst transfer state and maps succeeded to synced', async () => {
    const sourcePath = path.join(sourceDir, 'multi-xfer.txt');
    const syncedPath = path.join(sourceDir, 'synced-xfer.txt');
    await fs.writeFile(sourcePath, 'multi');
    await fs.writeFile(syncedPath, 'synced');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: tempDir,
    });
    const syncedArtifact = await addArtifact({
      planId: 1,
      sourcePath: syncedPath,
      config: getDefaultConfig(),
      repoRoot: tempDir,
    });

    upsertPendingTransfer(db, artifact.uuid, 'pending-node', 'upload');
    markTransferSucceeded(db, artifact.uuid, 'succeeded-node', 'download');
    markTransferInProgress(db, artifact.uuid, 'failed-node', 'download');
    markTransferFailed(db, artifact.uuid, 'failed-node', 'download', new Error('failed'));
    markTransferSucceeded(db, syncedArtifact.uuid, 'succeeded-node', 'download');

    const results = await listArtifacts({
      planId: 1,
      config: getDefaultConfig(),
      repoRoot: tempDir,
    });
    const byUuid = new Map(results.map((result) => [result.uuid, result]));
    expect(byUuid.get(artifact.uuid)?.transferState).toBe('failed');
    expect(byUuid.get(syncedArtifact.uuid)?.transferState).toBe('synced');
  });

  test('listArtifacts reports file-missing when bytes are absent with no transfer row', async () => {
    const sourcePath = path.join(sourceDir, 'missing-no-transfer.txt');
    await fs.writeFile(sourcePath, 'missing');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: tempDir,
    });
    await fs.rm(artifact.storagePath, { force: true });

    const results = await listArtifacts({
      planId: 1,
      config: getDefaultConfig(),
      repoRoot: tempDir,
    });
    expect(results[0].transferState).toBe('file-missing');
  });

  test('listArtifacts reports file-missing even when transfer row says succeeded', async () => {
    const sourcePath = path.join(sourceDir, 'missing-succeeded.txt');
    await fs.writeFile(sourcePath, 'missing');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: tempDir,
    });
    markTransferSucceeded(db, artifact.uuid, 'remote-node', 'download');
    await fs.rm(artifact.storagePath, { force: true });

    const results = await listArtifacts({
      planId: 1,
      config: getDefaultConfig(),
      repoRoot: tempDir,
    });
    expect(results[0].transferState).toBe('file-missing');
  });
});
