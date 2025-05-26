import { test, expect, describe } from 'bun:test';
import { formatFailuresForLlm } from './failures.js';
import type { NoMatchFailure, NotUniqueFailure, MatchLocation } from '../editor/types.js';

describe('formatFailuresForLlm', () => {
  test('should return a minimal message for an empty failures array', () => {
    const failures: (NoMatchFailure | NotUniqueFailure)[] = [];
    const expectedOutput = 'No failures to report.';
    expect(formatFailuresForLlm(failures)).toBe(expectedOutput);
  });

  test('should format a single NoMatchFailure without closest match', () => {
    const failure: NoMatchFailure = {
      type: 'noMatch',
      filePath: 'src/example.ts',
      originalText: 'const oldVar = 1;',
      updatedText: 'const newVar = 2;',
      closestMatch: null,
    };
    const expectedOutput = `The following edit(s) failed to apply:
Failure 1:
  File: src/example.ts
  Original text block intended for replacement:
\`\`\`
const oldVar = 1;
\`\`\`
  Reason: No Exact Match - The specified text block was not found.
  No close match could be identified in the file.
`;
    expect(formatFailuresForLlm([failure])).toBe(expectedOutput);
  });

  test('should format a single NoMatchFailure with closest match', () => {
    const failure: NoMatchFailure = {
      type: 'noMatch',
      filePath: 'src/example.ts',
      originalText: 'const oldVar = 1;\nconsole.log(oldVar);',
      updatedText: 'const newVar = 2;\nconsole.log(newVar);',
      closestMatch: {
        lines: ['const slightlyDifferentVar = 1;', 'console.log(slightlyDifferentVar);'],
        startLine: 5,
        endLine: 6,
        score: 0.8,
      },
    };
    const expectedOutput = `The following edit(s) failed to apply:
Failure 1:
  File: src/example.ts
  Original text block intended for replacement:
\`\`\`
const oldVar = 1;
console.log(oldVar);
\`\`\`
  Reason: No Exact Match - The specified text block was not found.
  Closest match found (lines 6-7):
\`\`\`
const slightlyDifferentVar = 1;
console.log(slightlyDifferentVar);
\`\`\`
  Diff between closest match and expected original text:
\`\`\`diff
    -const slightlyDifferentVar = 1;
    -console.log(slightlyDifferentVar);
    +const oldVar = 1;
    +console.log(oldVar);
\`\`\`
`;
    const result = formatFailuresForLlm([failure]);
    expect(result).toBe(expectedOutput);
  });

  test('should format a single NotUniqueFailure', () => {
    const failure: NotUniqueFailure = {
      type: 'notUnique',
      filePath: 'src/utils.ts',
      originalText: 'return value;',
      updatedText: 'return processedValue;',
      matchLocations: [
        { startLine: 10, startIndex: 4, contextLines: ['function A() {', '  return value;', '}'] },
        { startLine: 25, startIndex: 4, contextLines: ['function B() {', '  return value;', '}'] },
      ],
    };
    const expectedOutput = `The following edit(s) failed to apply:
Failure 1:
  File: src/utils.ts
  Original text block intended for replacement:
\`\`\`
return value;
\`\`\`
  Reason: Not Unique - The specified text block was found in 2 locations.
    Match 1 starting at line 11:
      Context:
      11: function A() {
      12:   return value;
      13: }
    Match 2 starting at line 26:
      Context:
      26: function B() {
      27:   return value;
      28: }
  The edit was ambiguous because`;
    expect(formatFailuresForLlm([failure])).toStartWith(expectedOutput);
  });

  test('should format a mix of failure types', () => {
    const failures: (NoMatchFailure | NotUniqueFailure)[] = [
      {
        type: 'noMatch',
        filePath: 'src/example.ts',
        originalText: 'const oldVar = 1;',
        updatedText: 'const newVar = 2;',
        closestMatch: null,
      },
      {
        type: 'notUnique',
        filePath: 'src/utils.ts',
        originalText: 'return value;',
        updatedText: 'return processedValue;',
        matchLocations: [
          {
            startLine: 10,
            startIndex: 4,
            contextLines: ['function A() {', '  return value;', '}'],
          },
        ],
      },
    ];
    const expectedOutput = `The following edit(s) failed to apply:
Failure 1:
  File: src/example.ts
  Original text block intended for replacement:
\`\`\`
const oldVar = 1;
\`\`\`
  Reason: No Exact Match - The specified text block was not found.
  No close match could be identified in the file.

---
Failure 2:
  File: src/utils.ts
  Original text block intended for replacement:
\`\`\`
return value;
\`\`\`
  Reason: Not Unique - The specified text block was found in 1 locations.
    Match 1 starting at line 11:
      Context:
      11: function A() {
      12:   return value;
      13: }
  The edit was ambiguous because`;
    expect(formatFailuresForLlm(failures)).toStartWith(expectedOutput);
  });

  test('should trim long text blocks', () => {
    const longText = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n');
    const failure: NoMatchFailure = {
      type: 'noMatch',
      filePath: 'src/long_file.txt',
      originalText: longText,
      updatedText: 'new content',
      closestMatch: null,
    };
    const result = formatFailuresForLlm([failure]);
    expect(result).toContain('Line 1\nLine 2\nLine 3\nLine 4\nLine 5');
    expect(result).toContain('... (trimmed 10 lines) ...');
    expect(result).toContain('Line 16\nLine 17\nLine 18\nLine 19\nLine 20');
    expect(result).not.toContain('Line 6');
    expect(result).not.toContain('Line 15');
  });
});
