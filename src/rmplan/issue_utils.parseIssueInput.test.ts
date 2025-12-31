import { describe, expect, test } from 'bun:test';
import { parseIssueInput } from './issue_utils.js';

describe('parseIssueInput', () => {
  describe('plain identifiers (not branch names)', () => {
    test('parses Linear key (uppercase)', () => {
      const result = parseIssueInput('DF-1245');
      expect(result).toEqual({
        identifier: 'DF-1245',
        isBranchName: false,
        originalInput: 'DF-1245',
      });
    });

    test('parses Linear key (lowercase)', () => {
      const result = parseIssueInput('df-1245');
      expect(result).toEqual({
        identifier: 'DF-1245',
        isBranchName: false,
        originalInput: 'df-1245',
      });
    });

    test('parses GitHub issue number', () => {
      const result = parseIssueInput('123');
      expect(result).toEqual({
        identifier: '123',
        isBranchName: false,
        originalInput: '123',
      });
    });

    test('parses Linear URL', () => {
      const result = parseIssueInput('https://linear.app/myworkspace/issue/DF-1245');
      expect(result).toEqual({
        identifier: 'DF-1245',
        isBranchName: false,
        originalInput: 'https://linear.app/myworkspace/issue/DF-1245',
      });
    });

    test('parses Linear URL with slug', () => {
      const result = parseIssueInput(
        'https://linear.app/myworkspace/issue/DF-1245/some-title-slug'
      );
      expect(result).toEqual({
        identifier: 'DF-1245',
        isBranchName: false,
        originalInput: 'https://linear.app/myworkspace/issue/DF-1245/some-title-slug',
      });
    });

    test('parses GitHub issue URL', () => {
      const result = parseIssueInput('https://github.com/owner/repo/issues/123');
      expect(result).toEqual({
        identifier: '123',
        isBranchName: false,
        originalInput: 'https://github.com/owner/repo/issues/123',
      });
    });
  });

  describe('branch names (containing issue IDs)', () => {
    test('parses branch with Linear-style issue ID suffix', () => {
      const result = parseIssueInput('feature-df-1245');
      expect(result).toEqual({
        identifier: 'DF-1245',
        isBranchName: true,
        originalInput: 'feature-df-1245',
      });
    });

    test('parses branch with Linear-style issue ID suffix (multiple parts)', () => {
      const result = parseIssueInput('feature-add-auth-DF-1245');
      expect(result).toEqual({
        identifier: 'DF-1245',
        isBranchName: true,
        originalInput: 'feature-add-auth-DF-1245',
      });
    });

    test('parses branch with simple number suffix - detected as plain Linear key', () => {
      // Note: feature-123 matches the plain Linear key pattern and is treated as such
      const result = parseIssueInput('feature-123');
      expect(result).toEqual({
        identifier: 'FEATURE-123',
        isBranchName: false,
        originalInput: 'feature-123',
      });
    });

    test('parses branch with multiple segments and number suffix', () => {
      // add-new-feature-123 has multiple segments, last part (feature-123) is Linear style
      const result = parseIssueInput('add-new-feature-123');
      expect(result).toEqual({
        identifier: 'FEATURE-123',
        isBranchName: true,
        originalInput: 'add-new-feature-123',
      });
    });

    test('parses branch ending in word-number as Linear-style (word becomes team key)', () => {
      // Note: fix-bug-123 matches -bug-123 which is interpreted as BUG-123 (Linear style)
      // This is consistent with the Linear client behavior
      const result = parseIssueInput('fix-bug-123');
      expect(result).toEqual({
        identifier: 'BUG-123',
        isBranchName: true,
        originalInput: 'fix-bug-123',
      });
    });
  });

  describe('invalid inputs', () => {
    test('returns null for invalid input', () => {
      expect(parseIssueInput('invalid')).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(parseIssueInput('')).toBeNull();
    });

    test('returns null for plain text without issue ID pattern', () => {
      expect(parseIssueInput('feature-branch')).toBeNull();
    });
  });

  describe('edge cases', () => {
    test('trims whitespace', () => {
      const result = parseIssueInput('  DF-1245  ');
      expect(result).toEqual({
        identifier: 'DF-1245',
        isBranchName: false,
        originalInput: 'DF-1245',
      });
    });

    test('handles alphanumeric team prefixes', () => {
      const result = parseIssueInput('ABC123-456');
      expect(result).toEqual({
        identifier: 'ABC123-456',
        isBranchName: false,
        originalInput: 'ABC123-456',
      });
    });
  });
});
