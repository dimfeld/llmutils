import { describe, expect, test } from 'bun:test';
import { ELLIPSIS_ASCII, formatHiddenNotesSummary } from './truncation.js';

describe('truncation helpers', () => {
  test('ELLIPSIS_ASCII is three dots', () => {
    expect(ELLIPSIS_ASCII).toBe('...');
  });

  test('formatHiddenNotesSummary formats count', () => {
    expect(formatHiddenNotesSummary(0)).toBe('');
    expect(formatHiddenNotesSummary(1)).toBe('... and 1 more earlier note(s)');
    expect(formatHiddenNotesSummary(2)).toBe('... and 2 more earlier note(s)');
  });
});

