<script lang="ts">
  import type { DiffLineAnnotation } from '@pierre/diffs';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { tick } from 'svelte';
  import Diff from '$lib/components/Diff.svelte';
  import { collectChangedLines } from '$common/review_guide_patch.js';
  import type { TocEntry } from '$lib/utils/markdown_parser.js';
  import type { FileTreeGroup } from '$lib/utils/review_file_tree.js';
  import {
    buildFullFileDiff,
    type FileCoverage,
    type ReviewFileEntry,
  } from '$lib/utils/review_guide_files.js';
  import type { ReviewIssueRow } from '$tim/db/review.js';
  import ReviewIssueAnnotation from '../../routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/ReviewIssueAnnotation.svelte';
  import {
    buildAnnotationsForFile,
    extractDiffLineRanges,
    type ReviewIssueAnnotationData,
  } from '../../routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/review_detail_utils.js';

  interface UncoveredMarker {
    type: 'uncovered';
    lineCount: number;
  }

  type FileAnnotationData = UncoveredMarker | (ReviewIssueAnnotationData & { type: 'issue' });

  interface Props {
    files: ReviewFileEntry[];
    /** Files grouped by category, in the order of the sidebar tree. */
    groups: FileTreeGroup[];
    coverage: Map<string, FileCoverage>;
    toc: TocEntry[];
    issues: ReviewIssueRow[];
    viewedFiles: ReadonlySet<string>;
    diffStyle: 'unified' | 'split';
    onToggleViewed: (path: string, viewed: boolean) => void;
    onJumpToSection: (slug: string) => void;
    onIssueClick: (issueId: number) => void;
  }

  let {
    files,
    groups,
    coverage,
    toc,
    issues,
    viewedFiles,
    diffStyle,
    onToggleViewed,
    onJumpToSection,
    onIssueClick,
  }: Props = $props();

  let onlyUndiscussed = $state(false);
  let hideViewed = $state(false);
  /** Files the reader opened or closed by hand; others follow the viewed state. */
  let openOverrides = $state<Record<string, boolean>>({});

  let tocBySlug = $derived(new Map(toc.map((entry) => [entry.slug, entry])));

  let entryByPath = $derived(new Map(files.map((entry) => [entry.row.path, entry])));

  function isFileShown(path: string): boolean {
    if (hideViewed && viewedFiles.has(path)) return false;
    if (onlyUndiscussed && (coverage.get(path)?.uncoveredLineCount ?? 0) === 0) return false;
    return true;
  }

  let visibleGroups = $derived(
    groups
      .map((group) => ({
        group,
        entries: group.paths
          .filter(isFileShown)
          .map((path) => entryByPath.get(path))
          .filter((entry): entry is ReviewFileEntry => entry != null),
      }))
      .filter(({ entries }) => entries.length > 0)
  );

  let root = $state<HTMLElement | null>(null);

  /**
   * Show a file and scroll to the annotation of an issue in it. The diff can
   * render its annotations a little later, so this tries for a short time.
   * Returns the annotation node, or null when the diff does not show the issue.
   */
  export async function revealIssue(issueId: number, path: string): Promise<HTMLElement | null> {
    await revealFile(path);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // The wrapper uses `display: contents`, so scroll to the annotation inside it.
      const node = root?.querySelector<HTMLElement>(`[data-files-issue-id="${issueId}"] > *`);
      if (node) {
        node.scrollIntoView({ behavior: 'instant', block: 'center' });
        return node;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  /** Show, open, and scroll to a file, also when a filter hides it. */
  export async function revealFile(path: string): Promise<void> {
    if (!entryByPath.has(path)) return;
    if (!isFileShown(path)) {
      hideViewed = false;
      onlyUndiscussed = false;
    }
    openOverrides[path] = true;
    await tick();
    document
      .getElementById(`review-file-${encodeURIComponent(path)}`)
      ?.scrollIntoView({ behavior: 'instant', block: 'start' });
  }

  let undiscussedFileCount = $derived(
    files.filter((entry) => (coverage.get(entry.row.path)?.uncoveredLineCount ?? 0) > 0).length
  );

  function isOpen(path: string): boolean {
    return openOverrides[path] ?? !viewedFiles.has(path);
  }

  function lineStats(entry: ReviewFileEntry): { added: number; deleted: number } {
    if (!entry.patchFile) return { added: 0, deleted: 0 };
    const { added, deleted } = collectChangedLines(entry.patchFile.hunks);
    return { added: added.size, deleted: deleted.size };
  }

  function changeLabel(entry: ReviewFileEntry): string {
    switch (entry.row.changeType) {
      case 'added':
        return 'A';
      case 'deleted':
        return 'D';
      case 'renamed':
        return 'R';
      default:
        return 'M';
    }
  }

  function annotationsFor(entry: ReviewFileEntry): DiffLineAnnotation<FileAnnotationData>[] {
    const path = entry.row.path;
    const annotations: DiffLineAnnotation<FileAnnotationData>[] = [];
    for (const block of coverage.get(path)?.uncoveredBlocks ?? []) {
      annotations.push({
        side: block.side,
        lineNumber: block.start,
        metadata: { type: 'uncovered', lineCount: block.end - block.start + 1 },
      });
    }
    if (entry.row.patch) {
      const ranges = extractDiffLineRanges(entry.row.patch, path);
      for (const annotation of buildAnnotationsForFile(issues, path, ranges)) {
        annotations.push({ ...annotation, metadata: { ...annotation.metadata, type: 'issue' } });
      }
    }
    return annotations;
  }

  // Build each file's diff once; Diff only reads its metadata when it first renders.
  let fileDiffs = $derived(
    new Map(files.map((entry) => [entry.row.path, buildFullFileDiff(entry)]))
  );
  let annotationsByPath = $derived(
    new Map(
      files.map((entry) => [entry.row.path, annotationsFor(entry) as DiffLineAnnotation<unknown>[]])
    )
  );
</script>

<div class="space-y-3 pb-6" bind:this={root}>
  <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
    <span>
      {files.length} changed file{files.length === 1 ? '' : 's'}
      {#if undiscussedFileCount > 0}
        · {undiscussedFileCount} with changes not shown in the guide
      {/if}
    </span>
    <label class="inline-flex items-center gap-1.5">
      <input type="checkbox" bind:checked={onlyUndiscussed} />
      Only files with changes not in the guide
    </label>
    <label class="inline-flex items-center gap-1.5">
      <input type="checkbox" bind:checked={hideViewed} />
      Hide viewed files
    </label>
  </div>

  {#snippet fileAnnotation(annotation: DiffLineAnnotation<unknown>)}
    {@const metadata = annotation.metadata as FileAnnotationData}
    {#if metadata.type === 'uncovered'}
      <div
        class="mx-1 rounded border border-dashed border-amber-400/70 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
      >
        {metadata.lineCount} changed line{metadata.lineCount === 1 ? '' : 's'} not shown in the guide
      </div>
    {:else}
      <div class="contents" data-files-issue-id={metadata.issueId}>
        <ReviewIssueAnnotation
          issueId={metadata.issueId}
          severity={metadata.severity}
          content={metadata.content}
          suggestion={metadata.suggestion}
          lineLabel={metadata.lineLabel}
          resolved={metadata.resolved}
          annotationKind={metadata.annotationKind}
          onClick={onIssueClick}
        />
      </div>
    {/if}
  {/snippet}

  {#each visibleGroups as { group, entries } (group.category)}
    {#if groups.length > 1}
      <h3 class="pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {group.label} ({entries.length})
      </h3>
    {/if}
    {#each entries as entry (entry.row.path)}
      {@const path = entry.row.path}
      {@const fileCoverage = coverage.get(path)}
      {@const stats = lineStats(entry)}
      {@const viewed = viewedFiles.has(path)}
      {@const open = isOpen(path)}
      {@const fileDiff = fileDiffs.get(path)}
      <section
        id="review-file-{encodeURIComponent(path)}"
        class="rounded-md border border-border"
        data-file-path={path}
      >
        <!-- Sticky inside the file card, so the Viewed checkbox stays in reach while the diff scrolls. -->
        <div class="sticky top-0 z-10 rounded-t-md bg-background">
          <div
            class="flex flex-wrap items-center gap-2 rounded-t-md border-b border-border bg-muted/40 px-3 py-1.5"
          >
            <button
              type="button"
              class="inline-flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
              onclick={() => (openOverrides[path] = !open)}
              aria-expanded={open}
            >
              {#if open}
                <ChevronDown class="size-3.5 shrink-0" />
              {:else}
                <ChevronRight class="size-3.5 shrink-0" />
              {/if}
              <span class="w-4 shrink-0 font-mono text-xs text-muted-foreground"
                >{changeLabel(entry)}</span
              >
              <span class="min-w-0 font-mono [overflow-wrap:anywhere]" title={path}>{path}</span>
              {#if entry.row.oldPath}
                <span class="truncate font-mono text-xs text-muted-foreground"
                  >← {entry.row.oldPath}</span
                >
              {/if}
            </button>
            <span class="font-mono text-xs">
              <span class="text-emerald-600 dark:text-emerald-400">+{stats.added}</span>
              <span class="text-red-600 dark:text-red-400">-{stats.deleted}</span>
            </span>
            {#if fileCoverage && fileCoverage.changedLineCount > 0}
              {#if fileCoverage.uncoveredLineCount === 0}
                <span
                  class="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                >
                  All changes in guide
                </span>
              {:else}
                <span
                  class="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                >
                  {fileCoverage.uncoveredLineCount} of {fileCoverage.changedLineCount} lines not in guide
                </span>
              {/if}
            {/if}
            <label class="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={viewed}
                onchange={(event) => {
                  const checked = event.currentTarget.checked;
                  delete openOverrides[path];
                  onToggleViewed(path, checked);
                }}
              />
              Viewed
            </label>
          </div>
        </div>
        {#if fileCoverage && fileCoverage.sectionSlugs.length > 0}
          <div class="flex flex-wrap gap-1 px-3 py-1 text-xs text-muted-foreground">
            In guide:
            {#each fileCoverage.sectionSlugs as slug (slug)}
              <button
                type="button"
                class="text-blue-600 hover:underline dark:text-blue-400"
                onclick={() => onJumpToSection(slug)}
              >
                {tocBySlug.get(slug)?.text ?? slug}
              </button>
            {/each}
          </div>
        {/if}
        {#if open}
          <div class="p-2">
            {#if fileDiff}
              <Diff
                {fileDiff}
                {diffStyle}
                disableFileHeader={true}
                lineAnnotations={annotationsByPath.get(path)}
                annotation={fileAnnotation}
              />
            {:else}
              <p class="px-1 text-xs text-muted-foreground">No text changes to show.</p>
            {/if}
          </div>
        {/if}
      </section>
    {/each}
  {/each}
</div>
