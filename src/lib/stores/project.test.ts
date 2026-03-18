import { describe, expect, test } from 'vitest';

import { projectDisplayName } from './project.svelte.js';

describe('projectDisplayName', () => {
  test('uses the last two repository_id segments', () => {
    expect(projectDisplayName('github.com__deviceflow__code', 'dimfeld')).toBe('deviceflow/code');
  });

  test('drops the first segment when it matches the current username', () => {
    expect(projectDisplayName('github.com__dimfeld__llmutils', 'dimfeld')).toBe('llmutils');
  });

  test('keeps both segments when the username does not match', () => {
    expect(projectDisplayName('github.com__dimfeld__llmutils', 'other-user')).toBe(
      'dimfeld/llmutils'
    );
  });

  test('falls back to the single trailing segment when only one segment is available', () => {
    expect(projectDisplayName('external-tasks', 'dimfeld')).toBe('external-tasks');
  });

  test('returns Unknown when repository_id is missing', () => {
    expect(projectDisplayName(null, 'dimfeld')).toBe('Unknown');
  });
});
