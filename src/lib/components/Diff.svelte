<script lang="ts">
  import {
    FileDiff,
    VirtualizedFileDiff,
    parseDiffFromFile,
    parsePatchFiles,
    type FileContents,
    type FileDiffMetadata,
    type DiffLineAnnotation,
    type FileDiffOptions,
    type Virtualizer,
  } from '@pierre/diffs';
  import WorkerUrl from '@pierre/diffs/worker/worker.js?worker&url';
  import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker';

  type DiffStyle = 'split' | 'unified';
  type HunkSeparatorStyle = 'line-info' | 'line-info-basic' | 'metadata' | 'simple';
  type LineDiffStyle = 'word-alt' | 'word' | 'char' | 'none';
  type OverflowStyle = 'scroll' | 'wrap';

  const HUNK_HEADER_RE = /^@@\s/m;
  const PATCH_HEADER_RE = /^---\s/m;
  const VIRTUALIZED_LINE_THRESHOLD = 400;

  let workerPool: ReturnType<typeof getOrCreateWorkerPoolSingleton> | undefined;

  function getWorkerPool() {
    if (typeof window === 'undefined') {
      return undefined;
    }

    workerPool ??= getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: () =>
          new Worker(WorkerUrl, {
            type: 'module',
          }),
      },
      highlighterOptions: {
        theme: { dark: 'pierre-dark', light: 'pierre-light' },
      },
    });

    return workerPool;
  }

  /** If the patch is just a raw hunk (starts with @@ but has no --- header),
   *  wrap it with minimal file headers so parsePatchFiles can parse it. */
  function normalizePatch(raw: string, filename?: string): string {
    if (PATCH_HEADER_RE.test(raw)) {
      return raw;
    }
    if (HUNK_HEADER_RE.test(raw)) {
      const name = filename ?? 'file';
      return `--- a/${name}\n+++ b/${name}\n${raw}`;
    }
    return raw;
  }

  let {
    oldFile,
    newFile,
    patch,
    filename,
    fileDiff,
    diffStyle = 'unified',
    hunkSeparators = 'line-info-basic',
    lineDiffType = 'word-alt',
    overflow = 'scroll',
    disableFileHeader = false,
    disableLineNumbers = false,
    collapsed = false,
    lineAnnotations,
    renderAnnotation,
    enableLineSelection = false,
    onLineSelected,
    enableGutterUtility = false,
    onGutterUtilityClick,
    onLineClick,
    virtualizer,
    class: className = '',
  }: {
    /** Old file version for two-file comparison */
    oldFile?: FileContents;
    /** New file version for two-file comparison */
    newFile?: FileContents;
    /** Unified diff / patch string, or a raw hunk starting with @@ (alternative to oldFile/newFile).
     *  Raw hunks are auto-detected and wrapped with file headers. */
    patch?: string;
    /** Filename used when auto-wrapping a raw hunk into a patch. Also used for language detection. */
    filename?: string;
    /** Pre-parsed diff metadata (alternative to oldFile/newFile or patch) */
    fileDiff?: FileDiffMetadata;
    /** Side-by-side or single column */
    diffStyle?: DiffStyle;
    /** What to show between diff hunks */
    hunkSeparators?: HunkSeparatorStyle;
    /** Inline change highlighting mode */
    lineDiffType?: LineDiffStyle;
    /** Long line handling */
    overflow?: OverflowStyle;
    /** Hide the file header */
    disableFileHeader?: boolean;
    /** Hide line numbers */
    disableLineNumbers?: boolean;
    /** Collapse file body, keep header visible */
    collapsed?: boolean;
    /** Annotations to render on specific lines */
    lineAnnotations?: DiffLineAnnotation<unknown>[];
    /** Custom annotation renderer */
    renderAnnotation?: FileDiffOptions<unknown>['renderAnnotation'];
    /** Enable click-to-select on line numbers */
    enableLineSelection?: boolean;
    /** Callback when line selection completes */
    onLineSelected?: FileDiffOptions<unknown>['onLineSelected'];
    /** Show gutter utility button (e.g. for adding comments) */
    enableGutterUtility?: boolean;
    /** Callback when gutter utility button is clicked */
    onGutterUtilityClick?: FileDiffOptions<unknown>['onGutterUtilityClick'];
    /** Callback when a line is clicked */
    onLineClick?: FileDiffOptions<unknown>['onLineClick'];
    /** Shared top-level virtualizer from a parent scroll container */
    virtualizer?: Virtualizer | null;
    /** Additional CSS classes for the wrapper div */
    class?: string;
  } = $props();

  let resolvedDiff = $derived.by(() => {
    if (fileDiff) {
      return fileDiff;
    }

    if (patch) {
      try {
        const parsed = parsePatchFiles(normalizePatch(patch, filename));
        return parsed[0]?.files[0] ?? null;
      } catch (e) {
        console.error(e);
        return null;
      }
    }

    if (oldFile && newFile) {
      try {
        return parseDiffFromFile(oldFile, newFile);
      } catch (e) {
        console.error(e);
        return null;
      }
    }

    return null;
  });

  let shouldVirtualize = $derived.by(() => {
    if (!resolvedDiff || !virtualizer) {
      return false;
    }

    const totalLines = Math.max(
      resolvedDiff.additionLines.length,
      resolvedDiff.deletionLines.length
    );

    return totalLines >= VIRTUALIZED_LINE_THRESHOLD;
  });

  function buildOptions(): FileDiffOptions<unknown> {
    return {
      theme: { dark: 'pierre-dark', light: 'pierre-light' } as const,
      diffStyle,
      hunkSeparators,
      lineDiffType,
      overflow,
      disableFileHeader,
      disableLineNumbers,
      collapsed,
      enableLineSelection,
      onLineSelected,
      enableGutterUtility,
      onGutterUtilityClick,
      onLineClick,
      renderAnnotation,
    };
  }

  function diffAttachment(node: HTMLElement) {
    const instance = new FileDiff<unknown>(buildOptions());

    if (resolvedDiff) {
      instance.render({
        fileDiff: resolvedDiff,
        lineAnnotations,
        containerWrapper: node,
      });
    }

    $effect(() => {
      if (!resolvedDiff) {
        return;
      }

      instance.setOptions({
        ...instance.options,
        ...buildOptions(),
      });

      instance.render({
        fileDiff: resolvedDiff,
        lineAnnotations,
        containerWrapper: node,
      });
    });

    return () => {
      instance.cleanUp();
    };
  }

  function virtualizedDiffAttachment(node: HTMLElement) {
    if (!virtualizer) {
      return;
    }

    const instance = new VirtualizedFileDiff(
      buildOptions(),
      virtualizer,
      { lineHeight: 22, fileGap: 10 },
      getWorkerPool()
    );

    if (resolvedDiff) {
      instance.render({
        fileDiff: resolvedDiff,
        lineAnnotations,
        containerWrapper: node,
      });
    }

    $effect(() => {
      if (!resolvedDiff) {
        return;
      }

      instance.setOptions({
        ...instance.options,
        ...buildOptions(),
      });

      instance.render({
        fileDiff: resolvedDiff,
        lineAnnotations,
        containerWrapper: node,
      });
    });

    return () => {
      instance.cleanUp();
    };
  }
</script>

{#if resolvedDiff}
  {#if shouldVirtualize}
    <div class={className} {@attach virtualizedDiffAttachment}></div>
  {:else}
    <div class={className} {@attach diffAttachment}></div>
  {/if}
{/if}
