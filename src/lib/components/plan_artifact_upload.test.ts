import { describe, expect, test } from 'vitest';

import {
  MAX_ARTIFACT_BYTES,
  buildUploadFormData,
  checkUploadSize,
  parseUploadError,
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
