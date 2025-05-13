import { describe, expect, test } from 'bun:test';
import { parsePrIdentifier } from './main.js';

describe('parsePrIdentifier', () => {
  test('should parse valid full URL', () => {
    const identifier = 'https://github.com/dimfeld/llmutils/pull/123';
    const expected = {
      owner: 'dimfeld',
      repo: 'llmutils',
      prNumber: 123,
    };
    expect(parsePrIdentifier(identifier)).toEqual(expected);
  });

  test('should parse valid short format (owner/repo#123)', () => {
    const identifier = 'dimfeld/llmutils#456';
    const expected = {
      owner: 'dimfeld',
      repo: 'llmutils',
      prNumber: 456,
    };
    expect(parsePrIdentifier(identifier)).toEqual(expected);
  });

  test('should parse valid alternative short format (owner/repo/123)', () => {
    const identifier = 'dimfeld/llmutils/789';
    const expected = {
      owner: 'dimfeld',
      repo: 'llmutils',
      prNumber: 789,
    };
    expect(parsePrIdentifier(identifier)).toEqual(expected);
  });

  describe('invalid formats', () => {
    test('should return null for missing PR number in URL', () => {
      const identifier = 'https://github.com/dimfeld/llmutils/pull/';
      expect(parsePrIdentifier(identifier)).toBeNull();
    });

    test('should return null for non-numeric PR number in URL', () => {
      const identifier = 'https://github.com/dimfeld/llmutils/pull/abc';
      expect(parsePrIdentifier(identifier)).toBeNull();
    });

    test('should return null for missing PR number in short format', () => {
      const identifier = 'dimfeld/llmutils#';
      expect(parsePrIdentifier(identifier)).toBeNull();
    });

    test('should return null for non-numeric PR number in short format', () => {
      const identifier = 'dimfeld/llmutils#abc';
      expect(parsePrIdentifier(identifier)).toBeNull();
    });

    test('should return null for missing PR number in alternative short format', () => {
      const identifier = 'dimfeld/llmutils/';
      expect(parsePrIdentifier(identifier)).toBeNull();
    });

    test('should return null for non-numeric PR number in alternative short format', () => {
      const identifier = 'dimfeld/llmutils/abc';
      expect(parsePrIdentifier(identifier)).toBeNull();
    });

    test('should return null for incomplete owner/repo', () => {
      const identifier = 'dimfeld#123';
      expect(parsePrIdentifier(identifier)).toBeNull();
    });

    test('should return null for just owner/repo', () => {
      const identifier = 'dimfeld/llmutils';
      expect(parsePrIdentifier(identifier)).toBeNull();
    });

    test('should return null for a completely random string', () => {
      const identifier = 'just-a-string';
      expect(parsePrIdentifier(identifier)).toBeNull();
    });

    test('should return null for URL with incorrect path structure', () => {
      const identifier = 'https://github.com/dimfeld/pull/llmutils/123';
      expect(parsePrIdentifier(identifier)).toBeNull();
    });

    test('should return null for URL with missing owner', () => {
      const identifier = 'https://github.com//llmutils/pull/123';
      expect(parsePrIdentifier(identifier)).toBeNull();
    });

    test('should return null for URL with missing repo', () => {
      const identifier = 'https://github.com/dimfeld//pull/123';
      expect(parsePrIdentifier(identifier)).toBeNull();
    });
  });

  describe('GitHub Enterprise URLs (currently unsupported)', () => {
    test('should return null for GitHub Enterprise URL', () => {
      const identifier = 'https://github.enterprise.com/owner/repo/pull/123';
      // Current implementation only supports github.com
      expect(parsePrIdentifier(identifier)).toBeNull();
    });
  });
});
