import { describe, expect, test } from 'vitest';
import { computeReviewGuideDiffOverrideFlags } from './review_guide_view_utils.js';

describe('computeReviewGuideDiffOverrideFlags', () => {
  test('plan-mode (allowIssueActions=false) suppresses gutter and line selection', () => {
    const flags = computeReviewGuideDiffOverrideFlags('src/app.ts', false);
    expect(flags.enableLineSelection).toBe(false);
    expect(flags.enableGutterUtility).toBe(false);
    expect(flags.exposeGutterClick).toBe(false);
  });

  test('plan-mode with no filename also suppresses', () => {
    const flags = computeReviewGuideDiffOverrideFlags(null, false);
    expect(flags.enableLineSelection).toBe(false);
    expect(flags.enableGutterUtility).toBe(false);
    expect(flags.exposeGutterClick).toBe(false);
  });

  test('PR-mode with filename exposes gutter and line selection', () => {
    const flags = computeReviewGuideDiffOverrideFlags('src/app.ts', true);
    expect(flags.enableLineSelection).toBe(true);
    expect(flags.enableGutterUtility).toBe(true);
    expect(flags.exposeGutterClick).toBe(true);
  });

  test('PR-mode without a filename still allows line selection but not the gutter "add issue" button', () => {
    const flags = computeReviewGuideDiffOverrideFlags(null, true);
    expect(flags.enableLineSelection).toBe(true);
    expect(flags.enableGutterUtility).toBe(false);
    expect(flags.exposeGutterClick).toBe(false);
  });
});
