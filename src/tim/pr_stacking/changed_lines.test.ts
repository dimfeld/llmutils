import { describe, expect, test } from 'vitest';
import { parseGitNumstat, parseGitPatchChangedLines } from './changed_lines.js';

describe('PR stacking changed-line counting', () => {
  test('counts additions and deletions from git numstat and ignores binary files', () => {
    expect(parseGitNumstat('12\t3\tsrc/a.ts\n4\t0\tsrc/b.ts\n-\t-\timage.png\n')).toBe(19);
  });

  test('counts patch additions and deletions without counting file headers', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,3 @@',
      '-old',
      '+new',
      '+another',
      ' unchanged',
    ].join('\n');

    expect(parseGitPatchChangedLines(patch)).toBe(3);
  });
});
