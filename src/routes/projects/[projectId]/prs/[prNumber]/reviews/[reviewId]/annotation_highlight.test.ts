import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { highlightAnnotationNode } from './annotation_highlight.js';

function makeFakeNode(): HTMLElement {
  const attrs = new Map<string, string>();
  const node = {
    style: {
      outline: '',
      outlineOffset: '',
      borderRadius: '',
      transition: '',
    } as CSSStyleDeclaration,
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
    getAttribute(name: string) {
      return attrs.has(name) ? attrs.get(name)! : null;
    },
    removeAttribute(name: string) {
      attrs.delete(name);
    },
  };
  return node as unknown as HTMLElement;
}

describe('highlightAnnotationNode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('sets data-highlighted and outline, then clears after the duration', () => {
    const node = makeFakeNode();
    highlightAnnotationNode(node, 1500);

    expect(node.getAttribute('data-highlighted')).toBe('true');
    expect(node.style.outline).toContain('2px');
    expect(node.style.outlineOffset).toBe('2px');

    vi.advanceTimersByTime(1500);

    expect(node.getAttribute('data-highlighted')).toBeNull();
    expect(node.style.outline).toBe('');
    expect(node.style.outlineOffset).toBe('');
  });

  test('cancel() clears the highlight early and prevents the timer from firing', () => {
    const node = makeFakeNode();
    const handle = highlightAnnotationNode(node, 1500);
    expect(node.getAttribute('data-highlighted')).toBe('true');

    handle.cancel();
    expect(node.getAttribute('data-highlighted')).toBeNull();
    expect(node.style.outline).toBe('');

    vi.advanceTimersByTime(5000);
    expect(node.getAttribute('data-highlighted')).toBeNull();
  });

  test('restores pre-existing inline styles after cleanup', () => {
    const node = makeFakeNode();
    node.style.outline = '1px dashed red';
    node.style.outlineOffset = '4px';
    node.style.borderRadius = '8px';

    highlightAnnotationNode(node, 500);
    vi.advanceTimersByTime(500);

    expect(node.style.outline).toBe('1px dashed red');
    expect(node.style.outlineOffset).toBe('4px');
    expect(node.style.borderRadius).toBe('8px');
  });

  test('sequential highlight calls with explicit cancellation keep only one final cleanup', () => {
    const node = makeFakeNode();
    const removeSpy = vi.spyOn(node, 'removeAttribute');

    const first = highlightAnnotationNode(node, 1000);
    first.cancel();

    highlightAnnotationNode(node, 1000);
    vi.advanceTimersByTime(999);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);

    expect(node.getAttribute('data-highlighted')).toBeNull();
    expect(removeSpy).toHaveBeenCalledTimes(2);
  });
});
