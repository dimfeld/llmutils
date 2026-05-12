import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getDefaultConfig } from '../../configSchema.js';
import { addArtifact, ArtifactNotFoundError } from '../../artifacts/service.js';
import { handleArtifactShowCommand } from './show.js';
import { setupArtifactCommandTest, type ArtifactCommandTestContext } from './test_utils.js';

describe('tim artifact show command', () => {
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

  test('prints JSON with fileExists=true when file is present', async () => {
    const sourcePath = path.join(context.sourceDir, 'show.txt');
    await fs.writeFile(sourcePath, 'show content');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });

    await handleArtifactShowCommand(artifact.uuid, { json: true });

    const payload = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string) as {
      uuid: string;
      sha256: string;
      transferState: string | null;
      fileExists: boolean;
    };
    expect(payload.uuid).toBe(artifact.uuid);
    expect(payload.fileExists).toBe(true);
    expect(payload.sha256).toEqual(expect.any(String));
    expect(payload.transferState).toBeNull();
    expect(payload).toMatchObject({
      filename: 'show.txt',
      mimeType: 'text/plain',
      message: null,
      deletedAt: null,
    });
  });

  test('prints JSON with fileExists=false when file is removed', async () => {
    const sourcePath = path.join(context.sourceDir, 'gone.txt');
    await fs.writeFile(sourcePath, 'data');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });
    await fs.rm(artifact.storagePath, { force: true });

    await handleArtifactShowCommand(artifact.uuid, { json: true });

    const payload = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string) as {
      fileExists: boolean;
    };
    expect(payload.fileExists).toBe(false);
  });

  test('prints text output with key metadata fields', async () => {
    const sourcePath = path.join(context.sourceDir, 'text.txt');
    await fs.writeFile(sourcePath, 'abc');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });

    await handleArtifactShowCommand(artifact.uuid, {});

    const output = consoleLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain(artifact.uuid);
    expect(output).toContain('text.txt');
    expect(output).toContain('text/plain');
  });

  test('throws ArtifactNotFoundError for unknown UUID', async () => {
    await expect(
      handleArtifactShowCommand('00000000-0000-4000-8000-000000000000', {})
    ).rejects.toThrow(ArtifactNotFoundError);
  });
});
