import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getDefaultConfig } from '../../configSchema.js';
import { getArtifactByUuid } from '../../db/artifact.js';
import { addArtifact, softDeleteArtifact } from '../../artifacts/service.js';
import { handleArtifactDeleteCommand } from './delete.js';
import {
  runWithConsoleLogger,
  setupArtifactCommandTest,
  type ArtifactCommandTestContext,
} from './test_utils.js';

describe('tim artifact delete command', () => {
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

  test('reports unknown soft-delete UUIDs as not found', async () => {
    await runWithConsoleLogger(() =>
      handleArtifactDeleteCommand('00000000-0000-4000-8000-000000000000')
    );

    const output = consoleLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('not found');
    expect(output).not.toContain('already deleted');
  });

  test('reports unknown hard-delete UUIDs as not found', async () => {
    await runWithConsoleLogger(() =>
      handleArtifactDeleteCommand('00000000-0000-4000-8000-000000000000', { hard: true })
    );

    const output = consoleLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('not found');
    expect(output).not.toContain('already deleted');
  });

  test('reports existing soft-deleted artifacts as already deleted', async () => {
    const sourcePath = path.join(context.sourceDir, 'already-deleted.log');
    await fs.writeFile(sourcePath, 'already deleted');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });
    await softDeleteArtifact(artifact.uuid, { config: getDefaultConfig() });

    await runWithConsoleLogger(() => handleArtifactDeleteCommand(artifact.uuid));

    const output = consoleLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('already deleted');
  });
});
