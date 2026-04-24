import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { getReviewGuideDiffId } from '$lib/utils/review_diff_ids.js';

vi.mock('$lib/components/Diff.svelte', async () => {
  const mod = await import('./__mocks__/DiffStub.svelte');
  return { default: mod.default };
});

import MarkdownContent from './MarkdownContent.svelte';

interface DiffOverrides {
  id?: string;
  lineAnnotations?: unknown[];
  enableGutterUtility?: boolean;
  enableLineSelection?: boolean;
  onGutterUtilityClick?: (r: unknown) => void;
  onLineSelected?: (r: unknown) => void;
}

function patchFor(filename: string): string {
  return `\`\`\`unified-diff
${diffBodyFor(filename)}
\`\`\``;
}

function diffBodyFor(filename: string): string {
  return `--- a/${filename}
+++ b/${filename}
@@ -1,1 +1,1 @@
-a
+b`;
}

describe('MarkdownContent diffOverrides forwarding', () => {
  test('passes lineAnnotations only to the matching filename', async () => {
    const content = `# Review\n\n${patchFor('foo.ts')}\n\nSome text.\n\n${patchFor('bar.ts')}\n`;

    const overrides = (
      filename: string | null,
      _patch: string,
      diffIndex: number
    ): DiffOverrides | undefined => {
      if (filename === 'foo.ts' && diffIndex === 1) {
        return {
          lineAnnotations: [{ side: 'additions', lineNumber: 1, metadata: { issueId: 1 } }],
        };
      }
      return undefined;
    };

    render(MarkdownContent, { content, diffOverrides: overrides });

    const stubs = page.getByTestId('diff-stub');
    await expect.element(stubs.nth(0)).toBeInTheDocument();
    await expect.element(stubs.nth(1)).toBeInTheDocument();

    // Locate by filename attribute
    const fooEl = document.querySelector('[data-testid="diff-stub"][data-filename="foo.ts"]');
    const barEl = document.querySelector('[data-testid="diff-stub"][data-filename="bar.ts"]');
    expect(fooEl).not.toBeNull();
    expect(barEl).not.toBeNull();
    expect(fooEl!.getAttribute('data-annotations-count')).toBe('1');
    expect(barEl!.getAttribute('data-annotations-count')).toBe('0');
  });

  test('forwards deterministic diff ids to each diff', async () => {
    const content = `${patchFor('foo.ts')}\n\n${patchFor('bar.ts')}\n`;

    const overrides = (
      filename: string | null,
      patch: string,
      _diffIndex: number
    ): DiffOverrides | undefined => {
      return { id: getReviewGuideDiffId(filename, patch) };
    };

    render(MarkdownContent, { content, diffOverrides: overrides });

    const stubs = page.getByTestId('diff-stub');
    await expect.element(stubs.nth(0)).toBeInTheDocument();
    await expect.element(stubs.nth(1)).toBeInTheDocument();

    const fooEl = document.querySelector('[data-testid="diff-stub"][data-filename="foo.ts"]');
    const barEl = document.querySelector('[data-testid="diff-stub"][data-filename="bar.ts"]');
    expect(fooEl?.id).toBe(getReviewGuideDiffId('foo.ts', diffBodyFor('foo.ts')));
    expect(barEl?.id).toBe(getReviewGuideDiffId('bar.ts', diffBodyFor('bar.ts')));
  });

  test('enableGutterUtility is forwarded per filename', async () => {
    const content = `${patchFor('foo.ts')}\n\n${patchFor('bar.ts')}\n`;

    const overrides = (
      filename: string | null,
      _patch: string,
      diffIndex: number
    ): DiffOverrides | undefined => {
      if (filename === 'foo.ts' && diffIndex === 0) {
        return { enableGutterUtility: true };
      }
      return undefined;
    };

    render(MarkdownContent, { content, diffOverrides: overrides });

    const stubs = page.getByTestId('diff-stub');
    await expect.element(stubs.nth(0)).toBeInTheDocument();
    await expect.element(stubs.nth(1)).toBeInTheDocument();

    const fooEl = document.querySelector('[data-testid="diff-stub"][data-filename="foo.ts"]');
    const barEl = document.querySelector('[data-testid="diff-stub"][data-filename="bar.ts"]');
    expect(fooEl!.getAttribute('data-gutter-enabled')).toBe('true');
    expect(barEl!.getAttribute('data-gutter-enabled')).toBe('false');
  });

  test('forwards diffAnnotation snippet to each diff', async () => {
    const content = `${patchFor('foo.ts')}\n\n${patchFor('bar.ts')}\n`;

    render(MarkdownContent, {
      content,
      diffAnnotation: (() => null) as never,
    });

    const stubs = page.getByTestId('diff-stub');
    await expect.element(stubs.nth(0)).toBeInTheDocument();
    await expect.element(stubs.nth(1)).toBeInTheDocument();

    const fooEl = document.querySelector('[data-testid="diff-stub"][data-filename="foo.ts"]');
    const barEl = document.querySelector('[data-testid="diff-stub"][data-filename="bar.ts"]');
    expect(fooEl!.getAttribute('data-has-annotation')).toBe('true');
    expect(barEl!.getAttribute('data-has-annotation')).toBe('true');
  });

  test('non-diff markdown still renders without emitting any Diff stubs', async () => {
    const content = '# Heading\n\nJust a paragraph with no diff blocks.';

    render(MarkdownContent, { content });

    await expect
      .element(page.getByText('Just a paragraph with no diff blocks.'))
      .toBeInTheDocument();
    const stubs = document.querySelectorAll('[data-testid="diff-stub"]');
    expect(stubs.length).toBe(0);
  });
});
