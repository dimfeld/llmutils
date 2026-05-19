import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';
import ReviewIssueAnnotation from './ReviewIssueAnnotation.svelte';

function defaultProps() {
  return {
    issueId: 1,
    severity: 'info' as const,
    content: 'content',
    suggestion: null,
    lineLabel: null,
    resolved: false,
    onClick: vi.fn(),
  };
}

describe('ReviewIssueAnnotation', () => {
  test('renders note content verbatim with whitespace-pre-wrap so newlines are preserved', () => {
    const { body } = render(ReviewIssueAnnotation, {
      props: {
        ...defaultProps(),
        severity: 'note',
        content: 'first line\nsecond line',
      },
    });

    expect(body).toContain('whitespace-pre-wrap');
    expect(body).toContain('first line\nsecond line');
  });

  test('non-note severities still go through the markdown renderer (no whitespace-pre-wrap)', () => {
    const { body } = render(ReviewIssueAnnotation, {
      props: {
        ...defaultProps(),
        severity: 'minor',
        content: 'plain text',
      },
    });

    expect(body).not.toContain('whitespace-pre-wrap');
    expect(body).toContain('plain text');
  });
});
