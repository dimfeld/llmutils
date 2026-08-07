import { describe, expect, test } from 'vitest';
import { extractRemoteErrorMessage } from './remote_error.js';

describe('extractRemoteErrorMessage', () => {
  test('extracts message from a SvelteKit remote-command error body', () => {
    const err = { body: { message: 'PR not found' } };
    expect(extractRemoteErrorMessage(err)).toBe('PR not found');
  });

  test('returns a string body directly', () => {
    const err = { body: 'raw string body' };
    expect(extractRemoteErrorMessage(err)).toBe('raw string body');
  });

  test('falls back to Error.message when there is no body', () => {
    const err = new Error('boom');
    expect(extractRemoteErrorMessage(err)).toBe('boom');
  });

  test('ignores a body object without a string message and falls back to Error.message', () => {
    const err = Object.assign(new Error('fallback message'), { body: { message: 42 } });
    expect(extractRemoteErrorMessage(err)).toBe('fallback message');
  });

  test('stringifies unrecognized values as a last resort', () => {
    expect(extractRemoteErrorMessage(null)).toBe('null');
    expect(extractRemoteErrorMessage(undefined)).toBe('undefined');
    expect(extractRemoteErrorMessage(42)).toBe('42');
  });
});
