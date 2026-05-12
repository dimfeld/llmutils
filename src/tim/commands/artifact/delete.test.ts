import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getDefaultConfig } from '../../configSchema.js';
import { getArtifactByUuid } from '../../db/artifact.js';
import { addArtifact } from '../../artifacts/service.js';
import { handleArtifactDeleteCommand } from './delete.js';
import { setupArtifactCommandTest, type ArtifactCommandTestContext } from './test_utils.js';

describe('tim artifact delete command', () => {
  let context: ArtifactCommandTestContext;

  beforeEach(async () => {
    context = await setupArtifactCommandTest();
  });

  afterEach(async () => {
    await context.restore();
  });

  test('soft-deletes by default and hard-deletes with --hard', async () => {
    const sourcePath = path.join(context.sourceDir, 'delete.log');
    await fs.writeFile(sourcePath, 'delete');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });

    await handleArtifactDeleteCommand(artifact.uuid);
    expect(getArtifactByUuid(context.db, artifact.uuid)?.deletedAt).toBeTruthy();
    await expect(fs.stat(artifact.storagePath)).resolves.toBeDefined();

    await handleArtifactDeleteCommand(artifact.uuid, { hard: true });
    expect(getArtifactByUuid(context.db, artifact.uuid)).toBeUndefined();
    await expect(fs.stat(artifact.storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
