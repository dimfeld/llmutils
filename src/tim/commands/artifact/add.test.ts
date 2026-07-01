import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getArtifactByUuid } from '../../db/artifact.js';
import { MAX_ARTIFACT_BYTES } from '../../artifacts/constants.js';
import { extractZip } from '../../artifacts/zip.js';
import { handleArtifactAddCommand } from './add.js';
import {
  runWithConsoleLogger,
  setupArtifactCommandTest,
  type ArtifactCommandTestContext,
} from './test_utils.js';

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

  function lastPayload(): Record<string, unknown> {
    return JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string) as Record<string, unknown>;
  }

  test('prints JSON and inserts the artifact', async () => {
    const sourcePath = path.join(context.sourceDir, 'capture.txt');
    await fs.writeFile(sourcePath, 'capture');

    await handleArtifactAddCommand('1', [sourcePath], {
      proof: true,
      message: 'run log',
      json: true,
    });

    const payload = lastPayload();
    expect(payload).toMatchObject({
      filename: 'capture.txt',
      mimeType: 'text/plain',
      size: 7,
      planUuid: '22222222-2222-4222-8222-222222222222',
      projectUuid: context.projectUuid,
      message: 'tim-proof:run log',
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
      message: 'tim-proof:run log',
      filename: 'capture.txt',
    });
  });

  test('prints text output with UUID when not using --json', async () => {
    const sourcePath = path.join(context.sourceDir, 'output.log');
    await fs.writeFile(sourcePath, 'log content');

    await runWithConsoleLogger(() =>
      handleArtifactAddCommand('1', [sourcePath], { reference: true })
    );

    const output = consoleLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toMatch(/[0-9a-f-]{36}/); // UUID pattern
  });

  test('requires either --reference or --proof', async () => {
    const sourcePath = path.join(context.sourceDir, 'plain.txt');
    await fs.writeFile(sourcePath, 'plain');

    await expect(handleArtifactAddCommand('1', [sourcePath], {})).rejects.toThrow(
      /--reference or --proof/
    );
  });

  test('rejects both --reference and --proof', async () => {
    const sourcePath = path.join(context.sourceDir, 'both.txt');
    await fs.writeFile(sourcePath, 'both');

    await expect(
      handleArtifactAddCommand('1', [sourcePath], { reference: true, proof: true })
    ).rejects.toThrow(/cannot be both/);
  });

  test('rejects multiple files without --zip', async () => {
    const a = path.join(context.sourceDir, 'a.txt');
    const b = path.join(context.sourceDir, 'b.txt');
    await fs.writeFile(a, 'a');
    await fs.writeFile(b, 'b');

    await expect(handleArtifactAddCommand('1', [a, b], { reference: true })).rejects.toThrow(
      /only be attached together with --zip/
    );
  });

  test('rejects missing source file', async () => {
    const missingPath = path.join(context.sourceDir, 'does-not-exist.txt');
    await expect(handleArtifactAddCommand('1', [missingPath], { reference: true })).rejects.toThrow(
      /does not exist/
    );
  });

  test('rejects source file exceeding size cap', async () => {
    const largePath = path.join(context.sourceDir, 'large.bin');
    const file = await fs.open(largePath, 'w');
    try {
      await file.truncate(MAX_ARTIFACT_BYTES + 1);
    } finally {
      await file.close();
    }
    await expect(handleArtifactAddCommand('1', [largePath], { reference: true })).rejects.toThrow(
      /too large/
    );
  });

  test('--reference with -m writes a tim-reference: message with the description', async () => {
    const sourcePath = path.join(context.sourceDir, 'spec.md');
    await fs.writeFile(sourcePath, 'spec');

    await handleArtifactAddCommand('1', [sourcePath], {
      reference: true,
      message: 'API spec',
      json: true,
    });

    const payload = lastPayload();
    expect(payload.message).toBe('tim-reference:API spec');
    expect(getArtifactByUuid(context.db, payload.uuid as string)).toMatchObject({
      message: 'tim-reference:API spec',
    });
  });

  test('--reference without -m writes the bare tim-reference: prefix', async () => {
    const sourcePath = path.join(context.sourceDir, 'spec2.md');
    await fs.writeFile(sourcePath, 'spec2');

    await handleArtifactAddCommand('1', [sourcePath], { reference: true, json: true });

    const payload = lastPayload();
    expect(payload.message).toBe('tim-reference:');
    expect(getArtifactByUuid(context.db, payload.uuid as string)).toMatchObject({
      message: 'tim-reference:',
    });
  });

  test('--proof writes a tim-proof: message', async () => {
    const sourcePath = path.join(context.sourceDir, 'evidence.txt');
    await fs.writeFile(sourcePath, 'evidence');

    await handleArtifactAddCommand('1', [sourcePath], { proof: true, json: true });

    const payload = lastPayload();
    expect(payload.message).toBe('tim-proof:');
  });

  test('--zip on a directory zips its contents into a single archive', async () => {
    const dir = path.join(context.sourceDir, 'refs');
    await fs.mkdir(path.join(dir, 'nested'), { recursive: true });
    await fs.writeFile(path.join(dir, 'a.md'), 'alpha');
    await fs.writeFile(path.join(dir, 'nested', 'b.md'), 'beta');

    await handleArtifactAddCommand('1', [dir], { reference: true, zip: true, json: true });

    const payload = lastPayload();
    expect(payload.filename).toBe('refs.zip');
    expect(payload.mimeType).toBe('application/zip');

    const stored = await fs.readFile(payload.storagePath as string);
    const entries = extractZip(stored);
    const byName = new Map(entries.map((e) => [e.filename, e.data.toString('utf8')]));
    expect(byName.get('a.md')).toBe('alpha');
    expect(byName.get('nested/b.md')).toBe('beta');
  });

  test('--zip on multiple files zips them into artifacts.zip', async () => {
    const a = path.join(context.sourceDir, 'one.txt');
    const b = path.join(context.sourceDir, 'two.txt');
    await fs.writeFile(a, 'one');
    await fs.writeFile(b, 'two');

    await handleArtifactAddCommand('1', [a, b], { reference: true, zip: true, json: true });

    const payload = lastPayload();
    expect(payload.filename).toBe('artifacts.zip');

    const stored = await fs.readFile(payload.storagePath as string);
    const names = extractZip(stored)
      .map((e) => e.filename)
      .sort();
    expect(names).toEqual(['one.txt', 'two.txt']);
  });
});
