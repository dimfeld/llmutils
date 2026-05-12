import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getDefaultConfig } from '../../configSchema.js';
import { addArtifact, softDeleteArtifact } from '../../artifacts/service.js';
import { upsertPendingTransfer } from '../../db/artifact_transfer.js';
import { handleArtifactListCommand } from './list.js';
import { setupArtifactCommandTest, type ArtifactCommandTestContext } from './test_utils.js';

describe('tim artifact list command', () => {
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

  test('filters deleted artifacts unless requested', async () => {
    const activePath = path.join(context.sourceDir, 'active.log');
    const deletedPath = path.join(context.sourceDir, 'deleted.log');
    await fs.writeFile(activePath, 'active');
    await fs.writeFile(deletedPath, 'deleted');
    await addArtifact({
      planId: 1,
      sourcePath: activePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });
    const deleted = await addArtifact({
      planId: 1,
      sourcePath: deletedPath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });
    await softDeleteArtifact(deleted.uuid, { config: getDefaultConfig() });

    await handleArtifactListCommand('1', { json: true });
    let payload = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string) as Array<{
      filename: string;
    }>;
    expect(payload.map((artifact) => artifact.filename)).toEqual(['active.log']);

    await handleArtifactListCommand('1', { includeDeleted: true, json: true });
    payload = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string) as Array<{
      filename: string;
    }>;
    expect(payload.map((artifact) => artifact.filename).sort()).toEqual([
      'active.log',
      'deleted.log',
    ]);
  });

  test('JSON output includes all required fields including transferState', async () => {
    const sourcePath = path.join(context.sourceDir, 'data.txt');
    await fs.writeFile(sourcePath, 'data');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });

    await handleArtifactListCommand('1', { json: true });
    const payload = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string) as Array<
      Record<string, unknown>
    >;
    expect(payload).toHaveLength(1);
    const row = payload[0];
    expect(row).toMatchObject({
      uuid: artifact.uuid,
      filename: 'data.txt',
      mimeType: 'text/plain',
      size: 4,
    });
    expect('transferState' in row).toBe(true);
    expect(row.transferState).toBeNull();
  });

  test('transfer state column reflects artifact_transfer rows', async () => {
    const sourcePath = path.join(context.sourceDir, 'xfer.txt');
    await fs.writeFile(sourcePath, 'xfer');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });
    upsertPendingTransfer(context.db, artifact.uuid, 'remote-node', 'upload');

    await handleArtifactListCommand('1', { json: true });
    const payload = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string) as Array<{
      transferState: string | null;
    }>;
    expect(payload[0].transferState).toBe('pending');
  });

  test('text output includes a TRANSFER column header', async () => {
    const sourcePath = path.join(context.sourceDir, 'hdr.txt');
    await fs.writeFile(sourcePath, 'hdr');
    await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });

    await handleArtifactListCommand('1', {});
    const output = consoleLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('TRANSFER');
    expect(output).toContain('UUID');
  });
});
