import { describe, expect, test } from 'bun:test';
import type { TimConfig } from '../configSchema.js';
import { normalizeTags, validateTags } from './tags.js';

describe('normalizeTags', () => {
  test('lowercases, trims, deduplicates, and sorts tags', () => {
    const result = normalizeTags([' Frontend', 'BUG', 'frontend', '', '  ', 'Bug']);
    expect(result).toEqual(['bug', 'frontend']);
  });

  test('returns empty array for undefined or empty input', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags([])).toEqual([]);
  });
});

describe('validateTags', () => {
  test('normalizes tags when no allowlist is configured', () => {
    const result = validateTags([' FRONTEND ', 'Urgent', 'frontend']);
    expect(result).toEqual(['frontend', 'urgent']);
  });

  test('enforces allowlist from configuration', () => {
    const config = {
      tags: {
        allowed: ['Frontend', 'Backend'],
      },
    } as TimConfig;

    const result = validateTags(['frontend', 'backend'], config);
    expect(result).toEqual(['backend', 'frontend']);
  });

  test('throws helpful error for tags outside the allowlist', () => {
    const config = {
      tags: {
        allowed: ['frontend', 'urgent'],
      },
    } as TimConfig;

    expect(() => validateTags(['frontend', 'infra'], config)).toThrow(/Invalid tags?/i);
  });

  test('disallows all tags when allowlist is present but empty', () => {
    const config = {
      tags: {
        allowed: [],
      },
    } as TimConfig;

    expect(() => validateTags(['frontend'], config)).toThrow(/No tags are currently allowed/i);
  });
});
