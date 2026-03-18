import { describe, expect, test } from 'vitest';

import {
  getTextTruncationState,
  TEXT_TRUNCATE_CHAR_LIMIT,
  TRUNCATE_LINE_LIMIT,
} from './session_message_truncation.js';

describe('getTextTruncationState', () => {
  test('truncates large single-line payloads by character count', () => {
    const text = 'x'.repeat(TEXT_TRUNCATE_CHAR_LIMIT + 250);
    const result = getTextTruncationState(text, false);

    expect(result.isTruncatable).toBe(true);
    expect(result.truncationMode).toBe('chars');
    expect(result.displayText).toHaveLength(TEXT_TRUNCATE_CHAR_LIMIT + 3);
    expect(result.displayText.endsWith('...')).toBe(true);
    expect(result.hiddenCharCount).toBe(250);
  });

  test('keeps multiline truncation by line count', () => {
    const text = Array.from({ length: TRUNCATE_LINE_LIMIT + 2 }, (_, i) => `line ${i + 1}`).join(
      '\n'
    );
    const result = getTextTruncationState(text, false);

    expect(result.isTruncatable).toBe(true);
    expect(result.truncationMode).toBe('lines');
    expect(result.displayText).toBe(
      Array.from({ length: TRUNCATE_LINE_LIMIT }, (_, i) => `line ${i + 1}`).join('\n')
    );
    expect(result.hiddenLineCount).toBe(2);
  });
});
