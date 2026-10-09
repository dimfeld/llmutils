import { describe, expect, it, test } from 'vitest';
import {
  computeReviewGuideDiffOverrideFlags,
  readReviewGuideLocation,
  writeReviewGuideLocation,
} from './review_guide_view_utils.js';

describe('computeReviewGuideDiffOverrideFlags', () => {
  test('with filename exposes gutter and line selection', () => {
    const flags = computeReviewGuideDiffOverrideFlags('src/app.ts');
    expect(flags.enableLineSelection).toBe(true);
    expect(flags.enableGutterUtility).toBe(true);
    expect(flags.exposeGutterClick).toBe(true);
  });

  test('without a filename still allows line selection but not the gutter "add issue" button', () => {
    const flags = computeReviewGuideDiffOverrideFlags(null);
    expect(flags.enableLineSelection).toBe(true);
    expect(flags.enableGutterUtility).toBe(false);
    expect(flags.exposeGutterClick).toBe(false);
  });
});

describe('review guide location in the query string', () => {
  const base = 'http://localhost/projects/1/prs/2/reviews/3';

  it('reads the guide tab and section by default', () => {
    expect(readReviewGuideLocation('')).toEqual({ tab: 'guide', section: null, file: null });
    expect(readReviewGuideLocation('?section=core&file=a.ts')).toEqual({
      tab: 'guide',
      section: 'core',
      file: null,
    });
  });

  it('reads the files tab and file', () => {
    expect(readReviewGuideLocation('?tab=files&file=src%2Fa.ts&section=core')).toEqual({
      tab: 'files',
      section: null,
      file: 'src/a.ts',
    });
    expect(readReviewGuideLocation('?tab=unknown').tab).toBe('guide');
  });

  it('writes only the parameters for the active tab, and keeps other parameters', () => {
    const files = writeReviewGuideLocation(`${base}?x=1&section=old`, {
      tab: 'files',
      section: 'ignored',
      file: 'src/a b.ts',
    });
    const url = new URL(files);
    expect(url.searchParams.get('x')).toBe('1');
    expect(url.searchParams.get('tab')).toBe('files');
    expect(url.searchParams.get('file')).toBe('src/a b.ts');
    expect(url.searchParams.has('section')).toBe(false);

    const guide = writeReviewGuideLocation(files, { tab: 'guide', section: 'core', file: null });
    expect(guide).toBe(`${base}?x=1&section=core`);
    expect(writeReviewGuideLocation(guide, { tab: 'guide', section: null, file: null })).toBe(
      `${base}?x=1`
    );
  });

  it('round-trips through read and write', () => {
    const location = { tab: 'files' as const, section: null, file: 'docs/a&b.md' };
    const href = writeReviewGuideLocation(base, location);
    expect(readReviewGuideLocation(new URL(href).search)).toEqual(location);
  });
});
