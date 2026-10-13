import { describe, expect, test } from 'vitest';
import { formatSessionWindowTitle, projectChatLabel } from './session_window_title.js';

describe('projectChatLabel', () => {
  test('labels chats with a chat branch as project chats', () => {
    expect(projectChatLabel({ projectChatId: 'abc', projectChatBranch: 'chat/abc' })).toBe(
      'Project Chat'
    );
  });

  test('labels chats without a chat branch as trunk chats', () => {
    expect(projectChatLabel({ projectChatId: 'abc' })).toBe('Trunk Chat');
    expect(formatSessionWindowTitle({ command: 'chat', projectChatId: 'abc' })).toBe('Trunk Chat');
  });

  test('returns null for other sessions', () => {
    expect(projectChatLabel({})).toBeNull();
  });
});

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
