import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getDefaultConfig } from '../../configSchema.js';
import { addArtifact, softDeleteArtifact } from '../../artifacts/service.js';
import { markTransferSucceeded, upsertPendingTransfer } from '../../db/artifact_transfer.js';
import { handleArtifactListCommand } from './list.js';
import {
  runWithConsoleLogger,
  setupArtifactCommandTest,
  type ArtifactCommandTestContext,
} from './test_utils.js';

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
    expect(payload.map((artifact) => artifact.filename).toSorted()).toEqual([
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
      planUuid: artifact.planUuid,
      projectUuid: artifact.projectUuid,
      filename: 'data.txt',
      mimeType: 'text/plain',
      size: 4,
      message: null,
    });
    expect(row.sha256).toEqual(expect.any(String));
    expect(row.storagePath).toEqual(expect.any(String));
    expect(row.createdAt).toEqual(expect.any(String));
    expect(row.updatedAt).toEqual(expect.any(String));
    expect(row.deletedAt).toBeNull();
    expect(row.revision).toEqual(expect.any(Number));
    expect(row.transferState).toBeNull();
    expect(row.fileExists).toBeNull();
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

  test('JSON and text output show file-missing when local bytes are absent', async () => {
    const sourcePath = path.join(context.sourceDir, 'missing.txt');
    await fs.writeFile(sourcePath, 'missing');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });
    await fs.rm(artifact.storagePath, { force: true });

    await handleArtifactListCommand('1', { json: true });
    const payload = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string) as Array<{
      transferState: string | null;
    }>;
    expect(payload[0].transferState).toBe('file-missing');

    consoleLog.mockClear();
    await runWithConsoleLogger(() => handleArtifactListCommand('1', {}));
    const output = consoleLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('file-missing');
  });

  test('file-missing wins over a succeeded transfer row', async () => {
    const sourcePath = path.join(context.sourceDir, 'succeeded-missing.txt');
    await fs.writeFile(sourcePath, 'missing');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });
    markTransferSucceeded(context.db, artifact.uuid, 'remote-node', 'download');
    await fs.rm(artifact.storagePath, { force: true });

    await handleArtifactListCommand('1', { json: true });
    const payload = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string) as Array<{
      transferState: string | null;
    }>;
    expect(payload[0].transferState).toBe('file-missing');
  });

  test('JSON output for soft-deleted artifact has ISO deletedAt and null transferState', async () => {
    const sourcePath = path.join(context.sourceDir, 'soft.txt');
    await fs.writeFile(sourcePath, 'soft');
    const artifact = await addArtifact({
      planId: 1,
      sourcePath,
      config: getDefaultConfig(),
      repoRoot: context.tempDir,
    });
    await softDeleteArtifact(artifact.uuid, { config: getDefaultConfig() });

    await handleArtifactListCommand('1', { includeDeleted: true, json: true });
    const payload = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string) as Array<
      Record<string, unknown>
    >;
    const row = payload.find((r) => r.uuid === artifact.uuid);
    expect(row).toBeDefined();
    expect(typeof row!.deletedAt).toBe('string');
    expect(() => new Date(row!.deletedAt as string).toISOString()).not.toThrow();
    expect(row!.transferState).toBeNull();
    expect(row!.fileExists).toBeNull();
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

    await runWithConsoleLogger(() => handleArtifactListCommand('1', {}));
    const output = consoleLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('TRANSFER');
    expect(output).toContain('UUID');
  });
});
