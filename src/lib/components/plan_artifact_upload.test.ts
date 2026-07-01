import { describe, expect, test, vi } from 'vitest';

import {
  MAX_ARTIFACT_BYTES,
  buildShowDeletedUrl,
  buildUploadFormData,
  checkUploadSize,
  parseUploadError,
  uploadArtifact,
} from './plan_artifact_upload.js';

function makeFile(name = 'a.png', size = 100, type = 'image/png'): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('checkUploadSize', () => {
  test('accepts files at or below the 25 MB cap', () => {
    expect(checkUploadSize(0)).toEqual({ ok: true });
    expect(checkUploadSize(MAX_ARTIFACT_BYTES)).toEqual({ ok: true });
  });

  test('rejects files larger than the cap', () => {
    const result = checkUploadSize(MAX_ARTIFACT_BYTES + 1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('too large');
    expect(result.error).toContain('25 MB');
  });
});

describe('buildUploadFormData', () => {
  test('includes planUuid and file', () => {
    const file = makeFile();
    const form = buildUploadFormData({ planUuid: 'plan-uuid', file });
    expect(form.get('planUuid')).toBe('plan-uuid');
    expect(form.get('file')).toBeInstanceOf(File);
    expect(form.get('projectId')).toBeNull();
    expect(form.get('message')).toBeNull();
  });

  test('includes projectId when provided and not "all"', () => {
    const form = buildUploadFormData({
      planUuid: 'p',
      projectId: 42,
      file: makeFile(),
    });
    expect(form.get('projectId')).toBe('42');
  });

  test('omits projectId when value is "all"', () => {
    const form = buildUploadFormData({
      planUuid: 'p',
      projectId: 'all',
      file: makeFile(),
    });
    expect(form.get('projectId')).toBeNull();
  });

  test('includes trimmed non-empty message', () => {
    const form = buildUploadFormData({
      planUuid: 'p',
      file: makeFile(),
      message: '  hello  ',
    });
    expect(form.get('message')).toBe('hello');
  });

  test('omits message when blank/whitespace', () => {
    const form = buildUploadFormData({
      planUuid: 'p',
      file: makeFile(),
      message: '   ',
    });
    expect(form.get('message')).toBeNull();
  });

  test('wraps the message with the reference prefix when reference is true', () => {
    const form = buildUploadFormData({
      planUuid: 'p',
      file: makeFile(),
      message: 'API spec',
      reference: true,
    });
    expect(form.get('message')).toBe('tim-reference:API spec');
  });

  test('posts the bare reference prefix when reference is true with no message', () => {
    const form = buildUploadFormData({
      planUuid: 'p',
      file: makeFile(),
      reference: true,
    });
    expect(form.get('message')).toBe('tim-reference:');
  });

  test('does not wrap the message when reference is false', () => {
    const form = buildUploadFormData({
      planUuid: 'p',
      file: makeFile(),
      message: 'API spec',
      reference: false,
    });
    expect(form.get('message')).toBe('API spec');
  });
});

describe('parseUploadError', () => {
  test('returns canned message for 413', async () => {
    const response = new Response('{}', { status: 413 });
    expect(await parseUploadError(response)).toBe('File is too large. Maximum is 25 MB.');
  });

  test('extracts error field from JSON body', async () => {
    const response = new Response(JSON.stringify({ error: 'bad plan' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
    expect(await parseUploadError(response)).toBe('bad plan');
  });

  test('falls back to status code when body is unparseable', async () => {
    const response = new Response('not json', { status: 500 });
    expect(await parseUploadError(response)).toBe('Upload failed (500)');
  });
});

describe('uploadArtifact', () => {
  test('POSTs to /api/artifacts with FormData containing planUuid, projectId, file, and trimmed message', async () => {
    const file = makeFile('a.png', 10);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const result = await uploadArtifact({
      planUuid: 'plan-uuid',
      projectId: 42,
      file,
      message: '  hi  ',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/artifacts');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('planUuid')).toBe('plan-uuid');
    expect(form.get('projectId')).toBe('42');
    expect(form.get('message')).toBe('hi');
    expect(form.get('file')).toBeInstanceOf(File);
  });

  test('rejects oversized files before calling fetch', async () => {
    const file = makeFile('big.bin', MAX_ARTIFACT_BYTES + 1);
    const fetchImpl = vi.fn();
    const result = await uploadArtifact({
      planUuid: 'p',
      file,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('too large');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('surfaces 413 as a clear error', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 413 }));
    const result = await uploadArtifact({
      planUuid: 'p',
      file: makeFile(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(413);
    expect(result.error).toContain('25 MB');
  });

  test('surfaces fetch errors as upload errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const result = await uploadArtifact({
      planUuid: 'p',
      file: makeFile(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('network down');
  });
});

describe('buildShowDeletedUrl', () => {
  test('adds includeDeletedArtifacts=1 when toggled on', () => {
    const url = new URL('http://localhost/projects/1/plans/2');
    expect(buildShowDeletedUrl(url, true)).toBe('/projects/1/plans/2?includeDeletedArtifacts=1');
  });

  test('removes the param when toggled off', () => {
    const url = new URL('http://localhost/projects/1/plans/2?includeDeletedArtifacts=1&other=keep');
    expect(buildShowDeletedUrl(url, false)).toBe('/projects/1/plans/2?other=keep');
  });

  test('preserves other query params when adding', () => {
    const url = new URL('http://localhost/projects/1/plans/2?tab=details');
    expect(buildShowDeletedUrl(url, true)).toBe(
      '/projects/1/plans/2?tab=details&includeDeletedArtifacts=1'
    );
  });
});
