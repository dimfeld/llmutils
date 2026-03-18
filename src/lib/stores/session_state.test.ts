import { describe, expect, test } from 'vitest';

import { getSessionGroupKey, getSessionGroupLabel } from './session_state.svelte.js';

describe('getSessionGroupKey', () => {
  test('uses project id before working directory when project is known', () => {
    expect(
      getSessionGroupKey(
        42,
        'https://example.com/repo.git|/Users/dimfeld/Projects/example'
      )
    ).toBe('42|/Users/dimfeld/Projects/example');
  });

  test('falls back to raw group key when project is unknown', () => {
    expect(
      getSessionGroupKey(null, 'https://example.com/repo.git|/tmp/project')
    ).toBe('https://example.com/repo.git|/tmp/project');
  });

  test('falls back to repository identifier when working directory is missing', () => {
    expect(getSessionGroupKey(7, 'https://example.com/repo.git')).toBe('7|https://example.com/repo.git');
  });

  test('labels a known project with workspace path', () => {
    expect(
      getSessionGroupLabel('https://example.com/repo.git|/Users/dimfeld/Projects/example', 'my-project')
    ).toBe('my-project (Projects/example)');
  });

  test('labels an unknown project by workspace path only', () => {
    expect(getSessionGroupLabel('https://example.com/repo.git|/Users/dimfeld/Projects/example')).toBe(
      'repo (Projects/example)'
    );
  });

  test('labels a known project without workspace path as project only', () => {
    expect(getSessionGroupLabel('https://example.com/repo.git', 'my-project')).toBe('my-project');
  });
});
