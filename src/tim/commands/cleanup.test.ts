import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as loggingModule from '../../logging.js';
import * as artifactServiceModule from '../artifacts/service.js';
import { addArtifact, softDeleteArtifact } from '../artifacts/service.js';
import { getDefaultConfig } from '../configSchema.js';
import { getArtifactByUuid } from '../db/artifact.js';
import { resolveArtifactPath } from '../artifacts/storage.js';
import { handleCleanupCommand } from './cleanup.js';
import {
  runWithConsoleLogger,
  setupArtifactCommandTest,
  type ArtifactCommandTestContext,
} from './artifact/test_utils.js';

describe('tim cleanup command', () => {
  let context: ArtifactCommandTestContext;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let purgeSpy: ReturnType<typeof vi.spyOn> | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(async () => {
    context = await setupArtifactCommandTest();
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    purgeSpy?.mockRestore();
    purgeSpy = undefined;
    warnSpy?.mockRestore();
    warnSpy = undefined;
    consoleLog.mockRestore();
    await context.restore();
  });

  test('purges artifact rows and orphan files through the cleanup path', async () => {
    const softSource = path.join(context.sourceDir, 'soft.txt');
    const completedSource = path.join(context.sourceDir, 'completed.txt');
    await fs.writeFile(softSource, 'soft');
    await fs.writeFile(completedSource, 'completed');

    const softDeleted = await addArtifact({
      planId: 1,
      sourcePath: softSource,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });
    const completed = await addArtifact({
      planId: 1,
      sourcePath: completedSource,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });

    await softDeleteArtifact(softDeleted.uuid, { config: getDefaultConfig() });
    context.db
      .prepare("UPDATE plan_artifact SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE uuid = ?")
      .run(softDeleted.uuid);
    context.db
      .prepare(
        "UPDATE plan SET status = 'done', updated_at = '2026-01-01T00:00:00.000Z' WHERE uuid = ?"
      )
      .run(completed.planUuid);

    const oldOrphan = resolveArtifactPath(
      context.projectUuid,
      completed.planUuid,
      'old-orphan',
      '.txt'
    );
    await fs.writeFile(oldOrphan, 'orphan');
    const oldTime = new Date(Date.now() - 120_000);
    await fs.utimes(oldOrphan, oldTime, oldTime);

    await runWithConsoleLogger(() => handleCleanupCommand());

    expect(getArtifactByUuid(context.db, softDeleted.uuid)).toBeUndefined();
    expect(getArtifactByUuid(context.db, completed.uuid)).toBeUndefined();
    await expect(fs.stat(softDeleted.storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(completed.storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(oldOrphan)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(consoleLog.mock.calls.some((call) => String(call[0]).includes('Artifact purge:'))).toBe(
      true
    );
  });

  test('artifact purge dry run reports candidates without mutating rows or files', async () => {
    const sourcePath = path.join(context.sourceDir, 'dry-run.txt');
    await fs.writeFile(sourcePath, 'dry run');
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

    await runWithConsoleLogger(() => handleCleanupCommand({ dryRun: true }));

    expect(getArtifactByUuid(context.db, artifact.uuid)).toBeDefined();
    await expect(fs.stat(artifact.storagePath)).resolves.toBeDefined();
    expect(
      consoleLog.mock.calls.some((call) =>
        String(call[0]).includes('Artifact purge dry run: 1 row(s) would be deleted')
      )
    ).toBe(true);
  });

  test('warns and resolves when artifact purge fails', async () => {
    purgeSpy = vi
      .spyOn(artifactServiceModule, 'purgeArtifacts')
      .mockRejectedValueOnce(new Error('boom'));
    warnSpy = vi.spyOn(loggingModule, 'warn').mockImplementation(() => undefined);

    await expect(handleCleanupCommand({})).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to purge artifacts'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
