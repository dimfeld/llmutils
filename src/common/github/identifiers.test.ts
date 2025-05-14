import { describe, expect, test } from 'bun:test';
import { parsePrOrIssueNumber } from './identifiers.ts';

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
