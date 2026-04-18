import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffLineAnnotation } from '@pierre/diffs';

const { mountMock, unmountMock } = vi.hoisted(() => ({
  mountMock: vi.fn(),
  unmountMock: vi.fn(),
}));

vi.mock('svelte', () => ({
  mount: mountMock,
  unmount: unmountMock,
}));

import {
  createAnnotationRenderer,
  type ReviewIssueAnnotationMetadata,
} from './annotation_mount_helper.js';

function makeAnnotation(
  overrides: Partial<DiffLineAnnotation<ReviewIssueAnnotationMetadata>> = {}
): DiffLineAnnotation<ReviewIssueAnnotationMetadata> {
  return {
    side: 'additions',
    lineNumber: 12,
    metadata: {
      issueId: 42,
      severity: 'minor',
      content: 'Missing guard clause',
      suggestion: null,
      lineLabel: null,
    },
    ...overrides,
  };
}

describe('createAnnotationRenderer', () => {
  beforeEach(() => {
    mountMock.mockReset();
    unmountMock.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns expected renderer methods and disposeAll works when empty', () => {
    const renderer = createAnnotationRenderer({ onAnnotationClick: vi.fn() });
    expect(renderer).toMatchObject({
      renderAnnotation: expect.any(Function),
      getNodeForIssue: expect.any(Function),
      disposeAll: expect.any(Function),
    });
    expect(() => renderer.disposeAll()).not.toThrow();
  });

  it('renders an annotation, tracks by issue id, and disposes all mounts', () => {
    const createdNodes: HTMLElement[] = [];
    vi.stubGlobal('document', {
      createElement: vi.fn(() => {
        const node = {} as HTMLElement;
        createdNodes.push(node);
        return node;
      }),
    });
    mountMock.mockReturnValue({ $destroy: vi.fn() });

    const renderer = createAnnotationRenderer({ onAnnotationClick: vi.fn() });
    const annotation = makeAnnotation();
    const node = renderer.renderAnnotation(annotation);

    expect(node).toBe(createdNodes[0]);
    expect(renderer.getNodeForIssue(42)).toBe(createdNodes[0]);
    expect(mountMock).toHaveBeenCalledTimes(1);
    expect(mountMock.mock.calls[0]?.[1]).toMatchObject({
      target: createdNodes[0],
      props: expect.objectContaining({
        issueId: 42,
        severity: 'minor',
        content: 'Missing guard clause',
        suggestion: null,
        lineLabel: null,
      }),
    });

    renderer.disposeAll();
    expect(unmountMock).toHaveBeenCalledTimes(1);
    expect(renderer.getNodeForIssue(42)).toBeUndefined();
  });

  it('disposes previous mount when rendering the same annotation key again', () => {
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({}) as HTMLElement),
    });
    mountMock.mockReturnValue({ $destroy: vi.fn() });

    const renderer = createAnnotationRenderer({ onAnnotationClick: vi.fn() });
    const annotation = makeAnnotation({ side: 'deletions', lineNumber: 7 });

    renderer.renderAnnotation(annotation);
    renderer.renderAnnotation(annotation);

    // Second render with the same key tears down the first mount.
    expect(unmountMock).toHaveBeenCalledTimes(1);
  });

  it('syncRenderPass disposes entries whose keys were not re-requested', () => {
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({}) as HTMLElement),
    });
    mountMock.mockReturnValue({ $destroy: vi.fn() });

    const renderer = createAnnotationRenderer({ onAnnotationClick: vi.fn() });
    const a = makeAnnotation({ side: 'additions', lineNumber: 10 });
    const b = makeAnnotation({
      side: 'additions',
      lineNumber: 20,
      metadata: {
        issueId: 99,
        severity: 'major',
        content: 'Other',
        suggestion: null,
        lineLabel: null,
      },
    });

    renderer.renderAnnotation(a);
    renderer.renderAnnotation(b);
    expect(mountMock).toHaveBeenCalledTimes(2);

    // Only request `b` this pass → `a` should be disposed.
    renderer.syncRenderPass(new Set([renderer.keyFor(b)]));
    expect(unmountMock).toHaveBeenCalledTimes(1);
    expect(renderer.getNodeForIssue(a.metadata.issueId)).toBeUndefined();
    expect(renderer.getNodeForIssue(b.metadata.issueId)).toBeDefined();
  });

  it('repoints nodesByIssue to a live sibling when one of an issue’s annotations is disposed', () => {
    const createdNodes: HTMLElement[] = [];
    vi.stubGlobal('document', {
      createElement: vi.fn(() => {
        const node = {} as HTMLElement;
        createdNodes.push(node);
        return node;
      }),
    });
    mountMock.mockReturnValue({ $destroy: vi.fn() });

    const renderer = createAnnotationRenderer({ onAnnotationClick: vi.fn() });
    // Two annotations for the same issue (this can still happen if the same
    // issue is re-rendered with a different line number).
    const first = makeAnnotation({ side: 'additions', lineNumber: 10 });
    const second = makeAnnotation({ side: 'additions', lineNumber: 11 });

    renderer.renderAnnotation(first);
    renderer.renderAnnotation(second);

    const firstNode = createdNodes[0];
    const secondNode = createdNodes[1];
    // The map currently tracks whichever was written last (second).
    expect(renderer.getNodeForIssue(42)).toBe(secondNode);

    // Dispose only the second one via syncRenderPass — the issue still has
    // `first` mounted, and getNodeForIssue must repoint to a live node.
    renderer.syncRenderPass(new Set([renderer.keyFor(first)]));
    expect(renderer.getNodeForIssue(42)).toBe(firstNode);
  });

  it('swallows promise rejections from unmount during disposeAll', async () => {
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({}) as HTMLElement),
    });
    mountMock.mockReturnValue({ $destroy: vi.fn() });
    unmountMock.mockReturnValue(Promise.reject(new Error('boom')));

    const renderer = createAnnotationRenderer({ onAnnotationClick: vi.fn() });
    renderer.renderAnnotation(makeAnnotation());

    expect(() => renderer.disposeAll()).not.toThrow();
    // Yield to the microtask queue so any unhandled rejection would surface.
    await Promise.resolve();
  });
});
