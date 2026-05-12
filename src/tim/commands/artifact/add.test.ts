import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getArtifactByUuid } from '../../db/artifact.js';
import { MAX_ARTIFACT_BYTES } from '../../artifacts/constants.js';
import { handleArtifactAddCommand } from './add.js';
import { setupArtifactCommandTest, type ArtifactCommandTestContext } from './test_utils.js';

describe('tim artifact add command', () => {
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

  test('prints JSON and inserts the artifact', async () => {
    const sourcePath = path.join(context.sourceDir, 'capture.txt');
    await fs.writeFile(sourcePath, 'capture');

    await handleArtifactAddCommand('1', sourcePath, { message: 'run log', json: true });

    const payload = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      filename: 'capture.txt',
      mimeType: 'text/plain',
      size: 7,
      planUuid: '22222222-2222-4222-8222-222222222222',
      projectUuid: context.projectUuid,
      message: 'run log',
      transferState: null,
      fileExists: null,
    });
    expect(payload.uuid).toEqual(expect.any(String));
    expect(payload.sha256).toEqual(expect.any(String));
    expect(payload.storagePath).toEqual(expect.any(String));
    expect(payload.createdAt).toEqual(expect.any(String));
    expect(payload.updatedAt).toEqual(expect.any(String));
    expect(payload.deletedAt).toBeNull();
    expect(payload.revision).toEqual(expect.any(Number));
    expect(getArtifactByUuid(context.db, payload.uuid as string)).toMatchObject({
      message: 'run log',
      filename: 'capture.txt',
    });
  });

  test('prints text output with UUID when not using --json', async () => {
    const sourcePath = path.join(context.sourceDir, 'output.log');
    await fs.writeFile(sourcePath, 'log content');

    await handleArtifactAddCommand('1', sourcePath, {});

    const output = consoleLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toMatch(/[0-9a-f-]{36}/); // UUID pattern
  });

  test('rejects missing source file', async () => {
    const missingPath = path.join(context.sourceDir, 'does-not-exist.txt');
    await expect(handleArtifactAddCommand('1', missingPath, {})).rejects.toThrow(/does not exist/);
  });

  test('rejects source file exceeding size cap', async () => {
    const largePath = path.join(context.sourceDir, 'large.bin');
    const file = await fs.open(largePath, 'w');
    try {
      await file.truncate(MAX_ARTIFACT_BYTES + 1);
    } finally {
      await file.close();
    }
    await expect(handleArtifactAddCommand('1', largePath, {})).rejects.toThrow(/too large/);
  });
});
