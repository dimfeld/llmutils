import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { MAX_ARTIFACT_BYTES } from './constants.js';
import {
  artifactFileExists,
  getArtifactsRoot,
  removeArtifactFile,
  resolveArtifactPath,
  storeArtifactFile,
} from './storage.js';

describe('artifact storage', () => {
  let tempDir: string;
  let sourceDir: string;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-artifact-storage-test-'));
    sourceDir = path.join(tempDir, 'source');
    await fs.mkdir(sourceDir, { recursive: true });
    process.env.XDG_DATA_HOME = path.join(tempDir, 'data');
  });

  afterEach(async () => {
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('stores a file under the canonical artifact path and computes metadata', async () => {
    const content = 'known artifact content\n';
    const sourcePath = path.join(sourceDir, 'Screenshot.PNG');
    await fs.writeFile(sourcePath, content);

    const stored = await storeArtifactFile(
      sourcePath,
      'project-uuid',
      'plan-uuid',
      'artifact-uuid'
    );

    const expectedPath = path.join(
      tempDir,
      'data',
      'tim',
      'artifacts',
      'project-uuid',
      'plan-uuid',
      'artifact-uuid.png'
    );
    expect(getArtifactsRoot()).toBe(path.join(tempDir, 'data', 'tim', 'artifacts'));
    expect(stored).toEqual({
      size: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
      mimeType: 'image/png',
      storagePath: expectedPath,
      filename: 'Screenshot.PNG',
      ext: '.png',
    });
    await expect(fs.readFile(expectedPath, 'utf8')).resolves.toBe(content);
  });

  test('rejects files larger than the artifact size cap', async () => {
    const sourcePath = path.join(sourceDir, 'large.bin');
    const file = await fs.open(sourcePath, 'w');
    try {
      await file.truncate(MAX_ARTIFACT_BYTES + 1);
    } finally {
      await file.close();
    }

    await expect(
      storeArtifactFile(sourcePath, 'project-uuid', 'plan-uuid', 'large-artifact')
    ).rejects.toThrow(/too large/);
  });

  test('aborts and removes partial destination when streamed bytes exceed the size cap', async () => {
    const sourcePath = path.join(sourceDir, 'growing.bin');
    await fs.writeFile(sourcePath, Buffer.alloc(MAX_ARTIFACT_BYTES));
    const storagePath = resolveArtifactPath(
      'project-uuid',
      'plan-uuid',
      'growing-artifact',
      '.bin'
    );

    const storePromise = storeArtifactFile(
      sourcePath,
      'project-uuid',
      'plan-uuid',
      'growing-artifact'
    );
    await fs.appendFile(sourcePath, Buffer.alloc(1));

    await expect(storePromise).rejects.toThrow(/too large/);
    await expect(artifactFileExists(storagePath)).resolves.toBe(false);
  });

  test('checks file existence and removes files idempotently', async () => {
    const content = 'delete me';
    const sourcePath = path.join(sourceDir, 'delete-me.log');
    await fs.writeFile(sourcePath, content);
    const stored = await storeArtifactFile(sourcePath, 'project-uuid', 'plan-uuid', 'delete-uuid');

    await expect(artifactFileExists(stored.storagePath)).resolves.toBe(true);
    await removeArtifactFile(stored.storagePath);
    await expect(artifactFileExists(stored.storagePath)).resolves.toBe(false);
    await expect(removeArtifactFile(stored.storagePath)).resolves.toBeUndefined();
  });

  test('resolves artifact paths with supplied extension', () => {
    expect(resolveArtifactPath('project', 'plan', 'artifact', '.txt')).toBe(
      path.join(tempDir, 'data', 'tim', 'artifacts', 'project', 'plan', 'artifact.txt')
    );
    expect(resolveArtifactPath('project', 'plan', 'artifact', '')).toBe(
      path.join(tempDir, 'data', 'tim', 'artifacts', 'project', 'plan', 'artifact')
    );
  });

  test('defaults unknown extensions to application/octet-stream', async () => {
    const sourcePath = path.join(sourceDir, 'unknown.custom');
    await fs.writeFile(sourcePath, 'custom content');

    const stored = await storeArtifactFile(sourcePath, 'project-uuid', 'plan-uuid', 'unknown-uuid');

    expect(stored.mimeType).toBe('application/octet-stream');
  });

  test('detects jpeg mime type for .jpg and .jpeg extensions', async () => {
    const jpgPath = path.join(sourceDir, 'photo.jpg');
    await fs.writeFile(jpgPath, 'fake jpg data');
    const storedJpg = await storeArtifactFile(jpgPath, 'project-uuid', 'plan-uuid', 'jpg-uuid');
    expect(storedJpg.mimeType).toBe('image/jpeg');

    const jpegPath = path.join(sourceDir, 'photo.jpeg');
    await fs.writeFile(jpegPath, 'fake jpeg data');
    const storedJpeg = await storeArtifactFile(jpegPath, 'project-uuid', 'plan-uuid', 'jpeg-uuid');
    expect(storedJpeg.mimeType).toBe('image/jpeg');
  });

  test('detects application/json for .json extension', async () => {
    const jsonPath = path.join(sourceDir, 'data.json');
    await fs.writeFile(jsonPath, '{"key":"value"}');
    const stored = await storeArtifactFile(jsonPath, 'project-uuid', 'plan-uuid', 'json-uuid');
    expect(stored.mimeType).toBe('application/json');
  });

  test('throws when source file does not exist', async () => {
    const missingPath = path.join(sourceDir, 'does-not-exist.txt');
    await expect(
      storeArtifactFile(missingPath, 'project-uuid', 'plan-uuid', 'missing-uuid')
    ).rejects.toThrow(/does not exist/);
  });

  test('throws when source path is a directory', async () => {
    const dirPath = path.join(sourceDir, 'a-directory');
    await fs.mkdir(dirPath);
    await expect(
      storeArtifactFile(dirPath, 'project-uuid', 'plan-uuid', 'dir-uuid')
    ).rejects.toThrow(/not a regular file/);
  });
});
