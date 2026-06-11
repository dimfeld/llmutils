import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildServer } from '../../media-host/server.js';
import type { MediaHostConfig } from '../../media-host/server.js';
import { artifactMediaPath, uploadFile } from './client.js';

const API_KEY = 'test-api-key';
const SIGNING_SECRET = 'test-signing-secret';

describe('media_host client', () => {
  let storageDir: string;
  let server: ReturnType<typeof buildServer>;
  let baseUrl: string;

  beforeEach(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-host-client-test-'));
    const config: MediaHostConfig = {
      port: 0,
      host: '127.0.0.1',
      storageDir,
      apiKey: API_KEY,
      signingSecret: SIGNING_SECRET,
      maxUploadBytes: 1024,
    };
    server = buildServer(config);
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop(true);
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  test('uploads a file and returns an absolute signed URL that can be fetched', async () => {
    const result = await uploadFile({
      baseUrl,
      apiKey: API_KEY,
      relativePath: 'tim/plans/plan-1/artifact-1/screen shot.png',
      body: 'hello media host',
      contentType: 'text/plain',
    });

    expect(result.size).toBe('hello media host'.length);
    expect(result.url).toMatch(
      new RegExp(`^${baseUrl}/tim/plans/plan-1/artifact-1/screen%20shot\\.png\\?sig=`)
    );

    const download = await fetch(result.url);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('hello media host');
  });

  test('throws a clear error for a non-201 upload response (wrong token → 401)', async () => {
    await expect(
      uploadFile({
        baseUrl,
        apiKey: 'wrong-token',
        relativePath: 'tim/plans/plan-1/artifact-1/file.txt',
        body: 'nope',
      })
    ).rejects.toThrow('Media host upload failed with HTTP 401');
  });

  test('throws a clear error when upload exceeds server size limit (413)', async () => {
    const oversizedBody = 'x'.repeat(1025); // server maxUploadBytes is 1024
    await expect(
      uploadFile({
        baseUrl,
        apiKey: API_KEY,
        relativePath: 'tim/plans/plan-1/artifact-1/big.bin',
        body: oversizedBody,
        contentType: 'application/octet-stream',
      })
    ).rejects.toThrow('Media host upload failed with HTTP 413');
  });

  test('throws a clear error when no auth header is provided', async () => {
    // Pass an empty string as the API key — the bearer token will be "Bearer " which the
    // server rejects as unauthorized (falsy/empty token fails hasValidBearerToken).
    await expect(
      uploadFile({
        baseUrl,
        apiKey: '',
        relativePath: 'tim/plans/plan-1/artifact-1/file.txt',
        body: 'nope',
      })
    ).rejects.toThrow('Media host upload failed with HTTP 401');
  });

  test('re-uploading the same deterministic artifact path returns the same signed URL', async () => {
    const relativePath = artifactMediaPath('plan-uuid', 'artifact-uuid', 'proof image.png');

    const first = await uploadFile({
      baseUrl,
      apiKey: API_KEY,
      relativePath,
      body: 'first',
    });
    const second = await uploadFile({
      baseUrl,
      apiKey: API_KEY,
      relativePath,
      body: 'second',
    });

    expect(second.url).toBe(first.url);
    expect(second.size).toBe('second'.length);

    const download = await fetch(second.url);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('second');
  });

  test('artifactMediaPath is deterministic and keeps filenames path-safe', () => {
    expect(artifactMediaPath('plan-uuid', 'artifact-uuid', 'dir\\nested/file.txt')).toBe(
      'tim/plans/plan-uuid/artifact-uuid/dir_nested_file.txt'
    );
    expect(artifactMediaPath('plan-uuid', 'artifact-uuid', 'file.txt')).toBe(
      artifactMediaPath('plan-uuid', 'artifact-uuid', 'file.txt')
    );
  });
});
