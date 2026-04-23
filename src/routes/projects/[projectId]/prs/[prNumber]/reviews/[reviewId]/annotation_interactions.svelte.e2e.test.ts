import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

import { highlightAnnotationNode } from './annotation_highlight.js';
import ReviewIssueAnnotation from './ReviewIssueAnnotation.svelte';

describe('highlightAnnotationNode (real DOM)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('applies amber inline styles to a real node and clears after the timeout', () => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    try {
      highlightAnnotationNode(node, 1500);
      expect(node.getAttribute('data-highlighted')).toBe('true');
      expect(node.style.outline).toMatch(/#f59e0b|rgb\(245,\s*158,\s*11\)/i);
      expect(node.style.outlineOffset).toBe('2px');

      vi.advanceTimersByTime(1500);

      expect(node.getAttribute('data-highlighted')).toBeNull();
      expect(node.style.outline).toBe('');
    } finally {
      node.remove();
    }
  });

  test('cancel() stops the timer and clears immediately', () => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    try {
      const handle = highlightAnnotationNode(node, 1500);
      expect(node.getAttribute('data-highlighted')).toBe('true');
      handle.cancel();
      expect(node.getAttribute('data-highlighted')).toBeNull();
      vi.advanceTimersByTime(5000);
      expect(node.getAttribute('data-highlighted')).toBeNull();
    } finally {
      node.remove();
    }
  });
});

describe('ReviewIssueAnnotation click', () => {
  test('clicking the annotation button calls onClick with the issue id', async () => {
    const onClick = vi.fn();
    const screen = render(ReviewIssueAnnotation, {
      issueId: 42,
      severity: 'minor',
      content: 'Missing guard clause',
      suggestion: null,
      lineLabel: null,
      onClick,
    });

    // The button text is the truncated content.
    await screen.getByRole('button', { name: /Missing guard clause/ }).click();
    expect(onClick).toHaveBeenCalledWith(42);
  });

  test('renders the suggestion markdown when provided', () => {
    const onClick = vi.fn();
    const screen = render(ReviewIssueAnnotation, {
      issueId: 42,
      severity: 'minor',
      content: 'Missing guard clause',
      suggestion: 'Use the parsed value instead.',
      lineLabel: '10–12',
      onClick,
    });

    expect(screen.getByText('Suggestion')).toBeTruthy();
    expect(screen.getByText('Use the parsed value instead.')).toBeTruthy();
  });
});
