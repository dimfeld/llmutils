import { describe, expect, test } from 'vitest';

import { isLocalReturnPath } from './local_return_path.js';

describe('isLocalReturnPath', () => {
  test('accepts local paths', () => {
    expect(isLocalReturnPath('/projects/1/plans/2')).toBe(true);
    expect(isLocalReturnPath('/projects/1/prs?tab=checks#top')).toBe(true);
  });

  test('rejects relative and protocol-relative paths', () => {
    expect(isLocalReturnPath('projects/1')).toBe(false);
    expect(isLocalReturnPath('//evil.example')).toBe(false);
    expect(isLocalReturnPath('https://evil.example')).toBe(false);
    expect(isLocalReturnPath('')).toBe(false);
  });

  test('rejects backslashes and control characters', () => {
    expect(isLocalReturnPath('/\\evil.example')).toBe(false);
    expect(isLocalReturnPath('/projects\n/1')).toBe(false);
    expect(isLocalReturnPath('/projects\u0000')).toBe(false);
    expect(isLocalReturnPath('/projects\u001f')).toBe(false);
  });

  test('allows characters at and above the space character', () => {
    expect(isLocalReturnPath('/a b')).toBe(true);
    expect(isLocalReturnPath('/café')).toBe(true);
  });
});
