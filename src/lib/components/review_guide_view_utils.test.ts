import { describe, expect, test } from 'vitest';
import { computeReviewGuideDiffOverrideFlags } from './review_guide_view_utils.js';

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
