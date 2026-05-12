import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getDefaultConfig } from '../../configSchema.js';
import { addArtifact, softDeleteArtifact } from '../../artifacts/service.js';
import { getArtifactByUuid } from '../../db/artifact.js';
import { resolveArtifactPath } from '../../artifacts/storage.js';
import { handleArtifactPurgeCommand } from './purge.js';
import { setupArtifactCommandTest, type ArtifactCommandTestContext } from './test_utils.js';

describe('tim artifact purge command', () => {
  let context: ArtifactCommandTestContext;
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    context = await setupArtifactCommandTest();
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    consoleLog.mockRestore();
    await context.restore();
  });

  test('prints a dry-run JSON report', async () => {
    const sourcePath = path.join(context.sourceDir, 'old.log');
    await fs.writeFile(sourcePath, 'old');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });
    await softDeleteArtifact(artifact.uuid, { config: getDefaultConfig() });
    context.db
      .prepare("UPDATE plan_artifact SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE uuid = ?")
      .run(artifact.uuid);

    await handleArtifactPurgeCommand({ olderThan: '30', dryRun: true, json: true });

    const payload = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string);
    expect(payload).toMatchObject({
      softDeletedRowsHardDeleted: 1,
      completedPlanRowsHardDeleted: 0,
      orphanFilesRemoved: 0,
      dryRun: true,
    });
  });

  test('actually removes soft-deleted artifact file and row when not dry-run', async () => {
    const sourcePath = path.join(context.sourceDir, 'remove.log');
    await fs.writeFile(sourcePath, 'remove');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });
    await softDeleteArtifact(artifact.uuid, { config: getDefaultConfig() });
    context.db
      .prepare("UPDATE plan_artifact SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE uuid = ?")
      .run(artifact.uuid);

    await handleArtifactPurgeCommand({ olderThan: '30', json: true });

    expect(getArtifactByUuid(context.db, artifact.uuid)).toBeUndefined();
    await expect(fs.stat(artifact.storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('purges completed-plan artifacts', async () => {
    const sourcePath = path.join(context.sourceDir, 'done.txt');
    await fs.writeFile(sourcePath, 'done content');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });
    context.db
      .prepare(
        "UPDATE plan SET status = 'done', updated_at = '2026-01-01T00:00:00.000Z' WHERE uuid = ?"
      )
      .run(artifact.planUuid);

    await handleArtifactPurgeCommand({ olderThan: '30', json: true });

    const payload = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string);
    expect(payload.completedPlanRowsHardDeleted).toBe(1);
    expect(getArtifactByUuid(context.db, artifact.uuid)).toBeUndefined();
  });

  test('orphan file scan skips recently modified files (60s safety filter)', async () => {
    const sourcePath = path.join(context.sourceDir, 'source.txt');
    await fs.writeFile(sourcePath, 'source');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });

    // Create an orphan file (no DB row) in the artifact storage area but give it a fresh mtime
    const orphanPath = resolveArtifactPath(
      context.projectUuid,
      artifact.planUuid,
      'fresh-orphan-uuid',
      '.txt'
    );
    await fs.writeFile(orphanPath, 'orphan');
    // mtime is implicitly "now" — the safety filter (60s) should skip it

    await handleArtifactPurgeCommand({ olderThan: '0', includeActive: true, json: true });

    const payload = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string);
    // The fresh orphan must NOT be deleted
    expect(payload.orphanFilesRemoved).toBe(0);
    await expect(fs.stat(orphanPath)).resolves.toBeDefined();
  });
});
