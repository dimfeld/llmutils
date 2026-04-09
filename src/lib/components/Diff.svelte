<script lang="ts">
  import {
    FileDiff,
    parseDiffFromFile,
    parsePatchFiles,
    type FileContents,
    type FileDiffMetadata,
    type DiffLineAnnotation,
  } from '@pierre/diffs';

  type DiffStyle = 'split' | 'unified';
  type HunkSeparatorStyle = 'line-info' | 'line-info-basic' | 'metadata' | 'simple';
  type LineDiffStyle = 'word-alt' | 'word' | 'char' | 'none';
  type OverflowStyle = 'scroll' | 'wrap';

  const HUNK_HEADER_RE = /^@@\s/m;
  const PATCH_HEADER_RE = /^---\s/m;

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
    lineAnnotations?: DiffLineAnnotation[];
    /** Custom annotation renderer */
    renderAnnotation?: (annotation: DiffLineAnnotation) => HTMLElement | undefined;
    /** Enable click-to-select on line numbers */
    enableLineSelection?: boolean;
    /** Callback when line selection completes */
    onLineSelected?: (range: { start: number; end: number; side: string } | null) => void;
    /** Show gutter utility button (e.g. for adding comments) */
    enableGutterUtility?: boolean;
    /** Callback when gutter utility button is clicked */
    onGutterUtilityClick?: (range: {
      start: number;
      end: number;
      side: string;
      endSide: string;
    }) => void;
    /** Callback when a line is clicked */
    onLineClick?: (props: { lineNumber: number; side: string; event: MouseEvent }) => void;
    /** Additional CSS classes for the wrapper div */
    class?: string;
  } = $props();

  let resolvedDiff = $derived.by(() => {
    if (fileDiff) {
      return fileDiff;
    }

    if (patch) {
      const parsed = parsePatchFiles(normalizePatch(patch, filename));
      return parsed[0]?.files[0] ?? null;
    }

    if (oldFile && newFile) {
      return parseDiffFromFile(oldFile, newFile);
    }

    return null;
  });

  function diffAttachment(node: HTMLElement) {
    const instance = new FileDiff({
      theme: { dark: 'pierre-dark', light: 'pierre-light' },
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
    });

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
  <div class={className} {@attach diffAttachment}></div>
{/if}
