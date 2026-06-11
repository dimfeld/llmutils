import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { computePathSignature } from './security.js';
import { buildServer, createFetchHandler, normalizeMediaPath } from './server.js';
import type { MediaHostConfig } from './server.js';

const API_KEY = 'test-api-key';
const SIGNING_SECRET = 'test-signing-secret';

describe('media-host/normalizeMediaPath', () => {
  test('strips leading slashes and decodes', () => {
    expect(normalizeMediaPath('/images/cat.png')).toBe('images/cat.png');
    expect(normalizeMediaPath('/images/my%20cat.png')).toBe('images/my cat.png');
  });

  test('rejects empty paths and directory-like paths', () => {
    expect(normalizeMediaPath('/')).toBe(null);
    expect(normalizeMediaPath('')).toBe(null);
    expect(normalizeMediaPath('/images/')).toBe(null);
  });

  test('rejects NUL bytes', () => {
    expect(normalizeMediaPath('/images/%00cat.png')).toBe(null);
  });
});

describe('media-host server', () => {
  let storageDir: string;
  let server: ReturnType<typeof buildServer>;
  let baseUrl: string;
  let config: MediaHostConfig;

  beforeEach(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-host-test-'));
    config = {
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

  async function upload(relativePath: string, body: BodyInit, token = API_KEY): Promise<Response> {
    return fetch(`${baseUrl}/${relativePath}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
      body,
    });
  }

  test('health check responds', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('uploads a file with a valid bearer token and returns a signed url', async () => {
    const res = await upload('docs/readme.txt', 'hello world');
    expect(res.status).toBe(201);

    const payload = (await res.json()) as { path: string; size: number; url: string };
    expect(payload.path).toBe('docs/readme.txt');
    expect(payload.size).toBe('hello world'.length);

    const expectedSig = computePathSignature('docs/readme.txt', SIGNING_SECRET);
    expect(payload.url).toBe(`/docs/readme.txt?sig=${expectedSig}`);

    // The file actually landed on disk inside the storage dir.
    const onDisk = await fs.readFile(path.join(storageDir, 'docs/readme.txt'), 'utf8');
    expect(onDisk).toBe('hello world');
  });

  test('returns a signed url with reserved path characters encoded', async () => {
    const res = await upload('docs/a%3Fb%23c.txt', 'reserved');
    expect(res.status).toBe(201);

    const payload = (await res.json()) as { path: string; size: number; url: string };
    expect(payload.path).toBe('docs/a?b#c.txt');

    const expectedSig = computePathSignature('docs/a?b#c.txt', SIGNING_SECRET);
    expect(payload.url).toBe(`/docs/a%3Fb%23c.txt?sig=${expectedSig}`);

    const download = await fetch(`${baseUrl}${payload.url}`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('reserved');
  });

  test('rejects uploads without a valid token', async () => {
    const noToken = await fetch(`${baseUrl}/docs/readme.txt`, { method: 'PUT', body: 'x' });
    expect(noToken.status).toBe(401);

    const wrongToken = await upload('docs/readme.txt', 'x', 'nope');
    expect(wrongToken.status).toBe(401);

    // Nothing should have been written.
    await expect(fs.access(path.join(storageDir, 'docs/readme.txt'))).rejects.toThrow();
  });

  test('rejects uploads exceeding the max size', async () => {
    const tooBig = 'a'.repeat(2048);
    const res = await upload('big.bin', tooBig);
    expect(res.status).toBe(413);
  });

  test('rejects percent-encoded path traversal in uploads', async () => {
    // The URL parser resolves literal `../` dot-segments before we ever see the
    // pathname, so the real smuggling vector is an encoded slash (`%2f`): it
    // survives URL parsing and only becomes a separator once we decode it.
    // validatePath must reject the resulting escape.
    const handler = createFetchHandler(config);
    const res = await handler(
      new Request(`${baseUrl}/..%2fescape.txt`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${API_KEY}` },
        body: 'x',
      })
    );
    expect(res.status).toBe(400);
    await expect(fs.access(path.join(storageDir, '..', 'escape.txt'))).rejects.toThrow();
  });

  test('serves an uploaded file when the signature is valid', async () => {
    await upload('images/pixel.png', 'PNGDATA');
    const sig = computePathSignature('images/pixel.png', SIGNING_SECRET);

    const res = await fetch(`${baseUrl}/images/pixel.png?sig=${sig}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(await res.text()).toBe('PNGDATA');
  });

  test('refuses access without or with an invalid signature', async () => {
    await upload('images/pixel.png', 'PNGDATA');

    const missing = await fetch(`${baseUrl}/images/pixel.png`);
    expect(missing.status).toBe(403);

    const wrong = await fetch(`${baseUrl}/images/pixel.png?sig=deadbeef`);
    expect(wrong.status).toBe(403);

    // A signature minted for a different path must not unlock this one.
    const otherSig = computePathSignature('images/other.png', SIGNING_SECRET);
    const crossPath = await fetch(`${baseUrl}/images/pixel.png?sig=${otherSig}`);
    expect(crossPath.status).toBe(403);
  });

  test('returns 404 for a correctly signed but missing file', async () => {
    const sig = computePathSignature('missing.txt', SIGNING_SECRET);
    const res = await fetch(`${baseUrl}/missing.txt?sig=${sig}`);
    expect(res.status).toBe(404);
  });

  test('round-trips binary content unchanged', async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    await upload('videos/clip.mp4', bytes);
    const sig = computePathSignature('videos/clip.mp4', SIGNING_SECRET);

    const res = await fetch(`${baseUrl}/videos/clip.mp4?sig=${sig}`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test('rejects unsupported methods', async () => {
    const handler = createFetchHandler(config);
    const res = await handler(new Request(`${baseUrl}/foo.txt`, { method: 'DELETE' }));
    expect(res.status).toBe(405);
  });
});
