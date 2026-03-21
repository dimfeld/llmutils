import { describe, expect, test } from 'bun:test';
import { canonicalizePrUrl, parsePrOrIssueNumber, tryCanonicalizePrUrl } from './identifiers.ts';

describe('parsePrIdentifier', () => {
  test('should parse valid full URL', async () => {
    const identifier = 'https://github.com/dimfeld/llmutils/pull/123';
    const expected = {
      owner: 'dimfeld',
      repo: 'llmutils',
      number: 123,
    };
    expect(await parsePrOrIssueNumber(identifier)).toEqual(expected);
  });

  test('should parse valid short format (owner/repo#123)', async () => {
    const identifier = 'dimfeld/llmutils#456';
    const expected = {
      owner: 'dimfeld',
      repo: 'llmutils',
      number: 456,
    };
    expect(await parsePrOrIssueNumber(identifier)).toEqual(expected);
  });

  test('should parse valid alternative short format (owner/repo/123)', async () => {
    const identifier = 'dimfeld/llmutils/789';
    const expected = {
      owner: 'dimfeld',
      repo: 'llmutils',
      number: 789,
    };
    expect(await parsePrOrIssueNumber(identifier)).toEqual(expected);
  });

  describe('invalid formats', () => {
    test('should return null for missing PR number in URL', async () => {
      const identifier = 'https://github.com/dimfeld/llmutils/pull/';
      expect(await parsePrOrIssueNumber(identifier)).toBeNull();
    });

    test('should return null for non-numeric PR number in URL', async () => {
      const identifier = 'https://github.com/dimfeld/llmutils/pull/abc';
      expect(await parsePrOrIssueNumber(identifier)).toBeNull();
    });

    test('should return null for missing PR number in short format', async () => {
      const identifier = 'dimfeld/llmutils#';
      expect(await parsePrOrIssueNumber(identifier)).toBeNull();
    });

    test('should return null for non-numeric PR number in short format', async () => {
      const identifier = 'dimfeld/llmutils#abc';
      expect(await parsePrOrIssueNumber(identifier)).toBeNull();
    });

    test('should return null for missing PR number in alternative short format', async () => {
      const identifier = 'dimfeld/llmutils/';
      expect(await parsePrOrIssueNumber(identifier)).toBeNull();
    });

    test('should return null for non-numeric PR number in alternative short format', async () => {
      const identifier = 'dimfeld/llmutils/abc';
      expect(await parsePrOrIssueNumber(identifier)).toBeNull();
    });

    test('should return null for incomplete owner/repo', async () => {
      const identifier = 'dimfeld#123';
      expect(await parsePrOrIssueNumber(identifier)).toBeNull();
    });

    test('should return null for just owner/repo', async () => {
      const identifier = 'dimfeld/llmutils';
      expect(await parsePrOrIssueNumber(identifier)).toBeNull();
    });

    test('should return null for a completely random string', async () => {
      const identifier = 'just-a-string';
      expect(await parsePrOrIssueNumber(identifier)).toBeNull();
    });

    test('should return null for URL with missing owner', async () => {
      const identifier = 'https://github.com//llmutils/pull/123';
      expect(await parsePrOrIssueNumber(identifier)).toBeNull();
    });

    test('should return null for URL with missing repo', async () => {
      const identifier = 'https://github.com/dimfeld//pull/123';
      expect(await parsePrOrIssueNumber(identifier)).toBeNull();
    });
  });
});

describe('canonicalizePrUrl', () => {
  test('normalizes equivalent GitHub PR URLs to a canonical /pull form', () => {
    expect(
      canonicalizePrUrl(
        'https://github.com/dimfeld/llmutils/pulls/123/?tab=checks#partial-pull-merging'
      )
    ).toBe('https://github.com/dimfeld/llmutils/pull/123');
  });

  test('returns non-URL identifiers unchanged', () => {
    expect(canonicalizePrUrl('dimfeld/llmutils#123')).toBe('dimfeld/llmutils#123');
  });
});

describe('tryCanonicalizePrUrl', () => {
  test('returns null for GitHub issue URLs', () => {
    expect(tryCanonicalizePrUrl('https://github.com/dimfeld/llmutils/issues/123')).toBeNull();
  });

  test('returns null for non-GitHub URLs', () => {
    expect(tryCanonicalizePrUrl('https://example.com/dimfeld/llmutils/pull/123')).toBeNull();
  });

  test('rejects partially numeric PR numbers', () => {
    expect(tryCanonicalizePrUrl('https://github.com/dimfeld/llmutils/pull/123abc')).toBeNull();
    expect(() => canonicalizePrUrl('https://github.com/dimfeld/llmutils/pull/123abc')).toThrow(
      /Invalid pull request number/i
    );
  });
});
