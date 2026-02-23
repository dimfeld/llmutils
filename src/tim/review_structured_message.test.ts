import { describe, expect, test } from 'bun:test';
import { toStructuredReviewIssue, toStructuredReviewIssues } from './review_structured_message.js';

describe('review structured message mapping', () => {
  test('normalizes an issue to structured message shape', () => {
    expect(
      toStructuredReviewIssue({
        severity: 'major',
        category: 'testing',
        content: 'Increase coverage for edge cases',
        file: 'src/test.ts',
        line: 42,
        suggestion: 'Add a regression test',
      })
    ).toEqual({
      severity: 'major',
      category: 'testing',
      content: 'Increase coverage for edge cases',
      file: 'src/test.ts',
      line: '42',
      suggestion: 'Add a regression test',
    });
  });

  test('coerces nullable optional fields to empty strings', () => {
    expect(
      toStructuredReviewIssue({
        severity: 'info',
        category: 'other',
        content: 'Note',
        file: null,
        line: null,
        suggestion: null,
      })
    ).toEqual({
      severity: 'info',
      category: 'other',
      content: 'Note',
      file: '',
      line: '',
      suggestion: '',
    });
  });

  test('maps issue arrays and preserves existing string line values', () => {
    expect(
      toStructuredReviewIssues([
        {
          severity: 'critical',
          category: 'security',
          content: 'Injection risk',
          file: 'src/db.ts',
          line: '10-12',
          suggestion: undefined,
        },
        {
          severity: 'minor',
          category: 'style',
          content: 'Naming cleanup',
          file: undefined,
          line: undefined,
          suggestion: 'Rename variable',
        },
      ])
    ).toEqual([
      {
        severity: 'critical',
        category: 'security',
        content: 'Injection risk',
        file: 'src/db.ts',
        line: '10-12',
        suggestion: '',
      },
      {
        severity: 'minor',
        category: 'style',
        content: 'Naming cleanup',
        file: '',
        line: '',
        suggestion: 'Rename variable',
      },
    ]);
  });
});
