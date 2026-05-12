import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { getArtifactByUuid } from '$tim/db/artifact.js';
import { MAX_ARTIFACT_BYTES } from '$tim/artifacts/constants.js';
import {
  setupArtifactCommandTest,
  type ArtifactCommandTestContext,
} from '$tim/commands/artifact/test_utils.js';

// The mock must be declared before importing the route handler.
// We capture the context lazily so we can set it per test in beforeEach.
let ctx: ArtifactCommandTestContext;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: ctx?.db ? { sync: { nodeId: '00000000-0000-4000-8000-000000000001' } } : {},
    db: ctx?.db,
  }),
}));

import { POST } from './+server.js';

const PLAN_UUID = '22222222-2222-4222-8222-222222222222';

function makeFormDataRequest(fields: Record<string, string | Blob>): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return new Request('http://localhost/api/artifacts', {
    method: 'POST',
    body: form,
    headers: { 'content-length': '1000' },
  });
}

describe('/api/artifacts POST', () => {
  beforeEach(async () => {
    ctx = await setupArtifactCommandTest();
  });

  afterEach(async () => {
    await ctx.restore();
  });

  test('200 happy path: returns uuid, filename, mimeType, size and creates a DB row', async () => {
    const fileContent = 'hello artifact';
    const file = new File([fileContent], 'output.txt', { type: 'text/plain' });

    const response = await POST({
      request: makeFormDataRequest({ planUuid: PLAN_UUID, file }),
    } as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      filename: 'output.txt',
      mimeType: 'text/plain',
      size: fileContent.length,
    });
    expect(typeof body.uuid).toBe('string');
    expect(body.uuid).toMatch(/^[0-9a-f-]{36}$/);

    const row = getArtifactByUuid(ctx.db, body.uuid);
    expect(row).not.toBeUndefined();
    expect(row?.filename).toBe('output.txt');
  });

  test('preserves original filename, not temp file name', async () => {
    const file = new File(['data'], 'my-report.log', { type: 'text/plain' });

    const response = await POST({
      request: makeFormDataRequest({ planUuid: PLAN_UUID, file }),
    } as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.filename).toBe('my-report.log');
  });

  test('optional message field flows through to the artifact row', async () => {
    const file = new File(['log data'], 'trace.log', { type: 'text/plain' });

    const response = await POST({
      request: makeFormDataRequest({ planUuid: PLAN_UUID, file, message: 'step 3 trace' }),
    } as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    const row = getArtifactByUuid(ctx.db, body.uuid);
    expect(row?.message).toBe('step 3 trace');
  });

  test('400 when planUuid is missing', async () => {
    const file = new File(['x'], 'x.txt', { type: 'text/plain' });

    await expect(POST({ request: makeFormDataRequest({ file }) } as never)).rejects.toMatchObject({
      status: 400,
    });
  });

  test('400 when planUuid is invalid', async () => {
    const file = new File(['x'], 'x.txt', { type: 'text/plain' });

    await expect(
      POST({ request: makeFormDataRequest({ planUuid: 'abc', file }) } as never)
    ).rejects.toMatchObject({ status: 400 });
  });

  test('400 when projectId is invalid', async () => {
    const file = new File(['x'], 'x.txt', { type: 'text/plain' });

    await expect(
      POST({
        request: makeFormDataRequest({ planUuid: PLAN_UUID, projectId: 'nope', file }),
      } as never)
    ).rejects.toMatchObject({ status: 400 });
  });

  test('400 when file is missing', async () => {
    await expect(
      POST({ request: makeFormDataRequest({ planUuid: PLAN_UUID }) } as never)
    ).rejects.toMatchObject({ status: 400 });
  });

  test('404 when plan does not exist', async () => {
    const file = new File(['x'], 'x.txt', { type: 'text/plain' });

    await expect(
      POST({
        request: makeFormDataRequest({
          planUuid: '99999999-9999-4999-8999-999999999999',
          file,
        }),
      } as never)
    ).rejects.toMatchObject({ status: 404 });
  });

  test('404 when projectId does not match the plan project', async () => {
    const file = new File(['x'], 'x.txt', { type: 'text/plain' });

    await expect(
      POST({
        request: makeFormDataRequest({ planUuid: PLAN_UUID, projectId: '999', file }),
      } as never)
    ).rejects.toMatchObject({ status: 404 });
  });

  test('413 when file exceeds MAX_ARTIFACT_BYTES (pre-flight check)', async () => {
    // File.size check in the handler fires before writing to disk
    const oversized = new File([new Uint8Array(MAX_ARTIFACT_BYTES + 1)], 'big.bin', {
      type: 'application/octet-stream',
    });

    const response = await POST({
      request: makeFormDataRequest({ planUuid: PLAN_UUID, file: oversized }),
    } as never);

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'artifact_too_large', maxBytes: MAX_ARTIFACT_BYTES });
  });

  test('413 when content-length exceeds MAX_ARTIFACT_BYTES plus multipart allowance', async () => {
    const request = new Request('http://localhost/api/artifacts', {
      method: 'POST',
      body: new FormData(),
      headers: {
        'content-length': String(MAX_ARTIFACT_BYTES + 64 * 1024 + 1),
      },
    });

    const response = await POST({ request } as never);

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'artifact_too_large', maxBytes: MAX_ARTIFACT_BYTES });
  });

  test('411 when content-length is absent', async () => {
    const form = new FormData();
    form.append('planUuid', PLAN_UUID);
    form.append('file', new File(['x'], 'x.txt', { type: 'text/plain' }));

    const response = await POST({
      request: new Request('http://localhost/api/artifacts', { method: 'POST', body: form }),
    } as never);

    expect(response.status).toBe(411);
    await expect(response.json()).resolves.toMatchObject({ error: 'length_required' });
  });

  test('411 when content-length is not numeric', async () => {
    const form = new FormData();
    form.append('planUuid', PLAN_UUID);
    form.append('file', new File(['x'], 'x.txt', { type: 'text/plain' }));

    const response = await POST({
      request: new Request('http://localhost/api/artifacts', {
        method: 'POST',
        body: form,
        headers: { 'content-length': 'abc' },
      }),
    } as never);

    expect(response.status).toBe(411);
    await expect(response.json()).resolves.toMatchObject({ error: 'length_required' });
  });

  test('cleans up temp file on success', async () => {
    const tmpBefore = (await fsp.readdir(os.tmpdir())).filter((e) => e.startsWith('tim-artifact-'));

    const file = new File(['cleanup check'], 'cleanup.txt', { type: 'text/plain' });
    await POST({ request: makeFormDataRequest({ planUuid: PLAN_UUID, file }) } as never);

    const tmpAfter = (await fsp.readdir(os.tmpdir())).filter((e) => e.startsWith('tim-artifact-'));

    expect(tmpAfter.length).toBeLessThanOrEqual(tmpBefore.length);
  });

  test('cleans up temp file when plan is not found', async () => {
    const tmpBefore = (await fsp.readdir(os.tmpdir())).filter((e) => e.startsWith('tim-artifact-'));

    const file = new File(['data'], 'f.txt', { type: 'text/plain' });
    await POST({
      request: makeFormDataRequest({
        planUuid: '99999999-9999-4999-8999-999999999999',
        file,
      }),
    } as never).catch(() => {});

    const tmpAfter = (await fsp.readdir(os.tmpdir())).filter((e) => e.startsWith('tim-artifact-'));
    expect(tmpAfter.length).toBeLessThanOrEqual(tmpBefore.length);
  });

  test('file is stored under XDG_DATA_HOME artifacts directory', async () => {
    const file = new File(['stored content'], 'stored.txt', { type: 'text/plain' });

    const response = await POST({
      request: makeFormDataRequest({ planUuid: PLAN_UUID, file }),
    } as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    const row = getArtifactByUuid(ctx.db, body.uuid);
    expect(row?.storagePath).toContain(path.join(ctx.tempDir, 'data', 'tim', 'artifacts'));

    const stat = await fsp.stat(row!.storagePath);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe(file.size);
  });
});
