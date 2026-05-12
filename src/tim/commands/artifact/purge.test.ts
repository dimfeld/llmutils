import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getDefaultConfig } from '../../configSchema.js';
import { addArtifact, softDeleteArtifact } from '../../artifacts/service.js';
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
});
