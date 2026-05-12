import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getDefaultConfig } from '../../configSchema.js';
import { addArtifact, softDeleteArtifact, listArtifacts } from '../../artifacts/service.js';
import { handleArtifactRestoreCommand } from './restore.js';
import { setupArtifactCommandTest, type ArtifactCommandTestContext } from './test_utils.js';

describe('tim artifact restore command', () => {
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

  test('restores a soft-deleted artifact so it appears in default list again', async () => {
    const sourcePath = path.join(context.sourceDir, 'restore.txt');
    await fs.writeFile(sourcePath, 'restore');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });

    await softDeleteArtifact(artifact.uuid, { config: getDefaultConfig() });
    expect(
      await listArtifacts({ planId: 1, config: getDefaultConfig(), repoRoot: context.tempDir })
    ).toHaveLength(0);

    await handleArtifactRestoreCommand(artifact.uuid);
    expect(
      await listArtifacts({ planId: 1, config: getDefaultConfig(), repoRoot: context.tempDir })
    ).toHaveLength(1);
  });

  test('reports already-active artifact without error', async () => {
    const sourcePath = path.join(context.sourceDir, 'active.txt');
    await fs.writeFile(sourcePath, 'active');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });

    await handleArtifactRestoreCommand(artifact.uuid);
    const output = consoleLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('already active');
  });
});
