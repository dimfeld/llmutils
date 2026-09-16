import { describe, expect, test } from 'vitest';
import { formatSessionWindowTitle } from './session_window_title.js';

describe('formatSessionWindowTitle', () => {
  test('includes the plan ID and title', () => {
    expect(
      formatSessionWindowTitle({ command: 'chat', planId: 42, planTitle: 'Build feature' })
    ).toBe('#42: Build feature');
  });

  test('includes the PR number and title', () => {
    expect(
      formatSessionWindowTitle({ command: 'chat', linkedPrNumber: 17, linkedPrTitle: 'Fix bug' })
    ).toBe('PR #17: Fix bug');
  });

  test('includes both identifiers when both are available', () => {
    expect(
      formatSessionWindowTitle({
        command: 'review',
        linkedPlanId: 42,
        linkedPlanTitle: 'Build feature',
        linkedPrNumber: 17,
        linkedPrTitle: 'Fix bug',
      })
    ).toBe('#42: Build feature · PR #17: Fix bug');
  });

  test('falls back to the command when no target metadata is available', () => {
    expect(formatSessionWindowTitle({ command: 'chat' })).toBe('chat');
  });
});
