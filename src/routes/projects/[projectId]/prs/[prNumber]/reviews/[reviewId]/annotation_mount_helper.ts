import type { DiffLineAnnotation } from '@pierre/diffs';
import { mount, unmount } from 'svelte';

import type { ReviewSeverity } from '$tim/db/review.js';
import ReviewIssueAnnotation from './ReviewIssueAnnotation.svelte';

export interface ReviewIssueAnnotationMetadata {
  issueId: number;
  severity: ReviewSeverity;
  content: string;
  suggestion: string | null;
  lineLabel: string | null;
}

interface MountedEntry {
  component: Record<string, unknown>;
  node: HTMLElement;
  issueId: number;
}

export interface AnnotationRenderer {
  renderAnnotation(
    annotation: DiffLineAnnotation<ReviewIssueAnnotationMetadata>
  ): HTMLElement | undefined;
  getNodeForIssue(issueId: number): HTMLElement | undefined;
  /**
   * After a render cycle, dispose any mounted annotations whose keys were NOT
   * re-rendered in this pass. Pierre doesn't notify us when annotations are
   * removed, so the page is responsible for calling this once the diff has
   * been re-rendered with a new `lineAnnotations` list.
   */
  syncRenderPass(requestedKeys: Set<string>): void;
  keyFor(annotation: DiffLineAnnotation<ReviewIssueAnnotationMetadata>): string;
  disposeAll(): void;
}

export interface CreateAnnotationRendererOptions {
  onAnnotationClick: (issueId: number) => void;
}

function keyFor(annotation: DiffLineAnnotation<ReviewIssueAnnotationMetadata>): string {
  return `${annotation.metadata.issueId}-${annotation.side}-${annotation.lineNumber}`;
}

export function createAnnotationRenderer(
  options: CreateAnnotationRendererOptions
): AnnotationRenderer {
  const entries = new Map<string, MountedEntry>();
  const nodesByIssue = new Map<number, HTMLElement>();

  function disposeEntry(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    // unmount() returns a Promise; swallow cleanup errors since we're tearing
    // down — there's nothing sensible to do with a late failure here.
    try {
      const result = unmount(entry.component) as unknown;
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).catch(() => {});
      }
    } catch {
      // ignore
    }
    entries.delete(key);
    // If the by-issue map still points at the node we just tore down, repoint
    // to any other live entry for the same issue (multi-line issues can have
    // multiple mounted annotations), or drop the mapping if none remain.
    if (nodesByIssue.get(entry.issueId) === entry.node) {
      const replacement = [...entries.values()].find((e) => e.issueId === entry.issueId);
      if (replacement) {
        nodesByIssue.set(entry.issueId, replacement.node);
      } else {
        nodesByIssue.delete(entry.issueId);
      }
    }
  }

  function renderAnnotation(
    annotation: DiffLineAnnotation<ReviewIssueAnnotationMetadata>
  ): HTMLElement | undefined {
    if (!annotation.metadata) return undefined;

    const key = keyFor(annotation);

    // If Pierre re-renders the same annotation key, tear down the prior
    // mount so we don't leak a Svelte component.
    if (entries.has(key)) {
      disposeEntry(key);
    }

    const node = document.createElement('div');
    const component = mount(ReviewIssueAnnotation, {
      target: node,
      props: {
        issueId: annotation.metadata.issueId,
        severity: annotation.metadata.severity,
        content: annotation.metadata.content,
        suggestion: annotation.metadata.suggestion,
        lineLabel: annotation.metadata.lineLabel,
        onClick: options.onAnnotationClick,
      },
    }) as Record<string, unknown>;

    entries.set(key, { component, node, issueId: annotation.metadata.issueId });
    nodesByIssue.set(annotation.metadata.issueId, node);
    return node;
  }

  function getNodeForIssue(issueId: number): HTMLElement | undefined {
    return nodesByIssue.get(issueId);
  }

  function syncRenderPass(requestedKeys: Set<string>): void {
    for (const key of [...entries.keys()]) {
      if (!requestedKeys.has(key)) {
        disposeEntry(key);
      }
    }
  }

  function disposeAll() {
    for (const key of [...entries.keys()]) {
      disposeEntry(key);
    }
    nodesByIssue.clear();
  }

  return { renderAnnotation, getNodeForIssue, syncRenderPass, keyFor, disposeAll };
}
