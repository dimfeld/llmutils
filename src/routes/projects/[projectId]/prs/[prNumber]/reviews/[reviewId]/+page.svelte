<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { Virtualizer, type DiffLineAnnotation, type FileDiffOptions } from '@pierre/diffs';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
  import { onDestroy } from 'svelte';
  import { toggleReviewIssueResolved } from '$lib/remote/pr_reviews.remote.js';
  import {
    addReviewIssueToPlanTask,
    deleteReviewIssue,
  } from '$lib/remote/review_issue_actions.remote.js';
  import { updateReviewIssueFields } from '$lib/remote/pr_review_submission.remote.js';
  import CopyButton from '$lib/components/CopyButton.svelte';
  import MarkdownContent, { type DiffOverrides } from '$lib/components/MarkdownContent.svelte';
  import {
    extractHeadings,
    parseMarkdownWithDiffs,
    type TocEntry,
  } from '$lib/utils/markdown_parser.js';
  import {
    buildGuideDiffAnnotations,
    type ReviewIssueAnnotationData,
  } from './review_detail_utils.js';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import { Splitpanes, Pane } from 'svelte-splitpanes';
  import type { ReviewIssueRow, ReviewSeverity, ReviewCategory } from '$tim/db/review.js';
  import ReviewIssueCard from './ReviewIssueCard.svelte';
  import ReviewIssueAnnotation from './ReviewIssueAnnotation.svelte';
  import type { ReviewIssueAnnotationMetadata } from './annotation_types.js';
  import NewReviewIssueModal from './NewReviewIssueModal.svelte';
  import SubmitReviewDialog from './SubmitReviewDialog.svelte';
  import Send from '@lucide/svelte/icons/send';
  import { normalizeGutterRange } from './new_issue_modal_utils.js';
  import { extractRemoteErrorMessage } from './remote_error.js';
  import {
    highlightAnnotationNode,
    type AnnotationHighlightHandle,
  } from './annotation_highlight.js';
  import { createSaveEditHandler, createAnnotationClickHandler } from './page_handlers.js';
  import type { PrReviewSubmissionRow } from '$tim/db/review.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let projectId = $derived(page.params.projectId);
  let prNumber = $derived(page.params.prNumber);

  // Local state for optimistic issue updates. $derived is writable in Svelte 5,
  // so optimistic mutations work directly and the list auto-refreshes when
  // `data.issues` updates (e.g. after invalidateAll).
  let issues = $derived(data.issues.map((i) => ({ ...i })));

  let submissions = $derived<PrReviewSubmissionRow[]>(data.submissions ?? []);
  let submissionsById = $derived(
    new Map<number, PrReviewSubmissionRow>(submissions.map((s) => [s.id, s]))
  );

  let submitDialogOpen = $state(false);

  function openSubmitDialog() {
    submitDialogOpen = true;
  }

  function closeSubmitDialog() {
    submitDialogOpen = false;
  }

  async function handleSubmitted() {
    // Keep the dialog open so the user sees the result panel; refetch the
    // page data so submitted issues get their badges.
    await invalidateAll();
  }

  let togglingIssueIds = $state(new Set<number>());
  let issueActionError = $state<string | null>(null);

  const SEVERITY_ORDER: ReviewSeverity[] = ['critical', 'major', 'minor', 'info'];

  let groupedIssues = $derived.by(() => {
    const groups = new Map<ReviewSeverity, ReviewIssueRow[]>();
    for (const severity of SEVERITY_ORDER) {
      groups.set(severity, []);
    }
    for (const issue of issues) {
      groups.get(issue.severity)?.push(issue);
    }
    return groups;
  });

  let hasNewCommits = $derived(
    data.currentHeadSha != null &&
      data.review.reviewed_sha != null &&
      data.currentHeadSha !== data.review.reviewed_sha &&
      data.review.status === 'complete'
  );

  let unresolvedCount = $derived(issues.filter((i) => !i.resolved).length);
  let linkedPlanUuid = $derived(data.linkedPlanUuid);

  let toc = $derived<TocEntry[]>(
    data.review.review_guide ? extractHeadings(data.review.review_guide) : []
  );

  let reviewGuideText = $derived(data.review.review_guide ?? '');
  let guideSegments = $derived(parseMarkdownWithDiffs(reviewGuideText));

  // Track which TOC section is currently visible via Intersection Observer
  let visibleSectionSlug = $state<string>('');
  let isProgrammaticUpdate = $state(false);
  let isUserNavigating = $state(false);
  let guideVirtualizer = $state<Virtualizer | null>(null);

  interface NewIssueModalState {
    file: string;
    startLine: number;
    endLine: number;
    side: 'LEFT' | 'RIGHT';
  }
  let newIssueModalState = $state<NewIssueModalState | null>(null);

  let highlightedIssueId = $state<number | null>(null);

  const annotationClick = createAnnotationClickHandler({
    setHighlightedIssueId: (id) => {
      highlightedIssueId = id;
    },
  });

  const EMPTY_DIFF_ANNOTATIONS: DiffLineAnnotation<unknown>[] = [];

  type GuideIssueAnnotation = DiffLineAnnotation<ReviewIssueAnnotationData>;
  type DiffOverrideResolver = (
    filename: string | null,
    patch: string,
    diffIndex: number
  ) => DiffOverrides | undefined;

  let previousGuideIssueAnnotations = new Map<number, GuideIssueAnnotation[]>();
  const diffOverrideCache = new Map<
    number,
    {
      filename: string | null;
      lineAnnotations: DiffLineAnnotation<unknown>[];
      override: DiffOverrides;
    }
  >();
  const gutterClickHandlers = new Map<
    number,
    {
      filename: string;
      handler: NonNullable<FileDiffOptions<unknown>['onGutterUtilityClick']>;
    }
  >();

  function sameAnnotation(a: GuideIssueAnnotation, b: GuideIssueAnnotation): boolean {
    return (
      a.side === b.side &&
      a.lineNumber === b.lineNumber &&
      a.metadata.issueId === b.metadata.issueId &&
      a.metadata.severity === b.metadata.severity &&
      a.metadata.content === b.metadata.content &&
      a.metadata.suggestion === b.metadata.suggestion &&
      a.metadata.lineLabel === b.metadata.lineLabel
    );
  }

  function sameAnnotations(a: GuideIssueAnnotation[], b: GuideIssueAnnotation[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!sameAnnotation(a[i], b[i])) return false;
    }
    return true;
  }

  function stabilizeGuideIssueAnnotations(
    next: Map<number, GuideIssueAnnotation[]>
  ): Map<number, GuideIssueAnnotation[]> {
    const stable = new Map<number, GuideIssueAnnotation[]>();
    for (const [segmentIndex, annotations] of next) {
      const previous = previousGuideIssueAnnotations.get(segmentIndex);
      stable.set(
        segmentIndex,
        previous && sameAnnotations(previous, annotations) ? previous : annotations
      );
    }
    previousGuideIssueAnnotations = stable;
    return stable;
  }

  function getGutterClickHandler(
    diffIndex: number,
    filename: string
  ): NonNullable<FileDiffOptions<unknown>['onGutterUtilityClick']> {
    const cached = gutterClickHandlers.get(diffIndex);
    if (cached?.filename === filename) {
      return cached.handler;
    }

    const handler = (range: Parameters<typeof handleGutterUtilityClick>[1]) =>
      handleGutterUtilityClick(filename, range);
    gutterClickHandlers.set(diffIndex, { filename, handler });
    return handler;
  }

  function getDiffOverrides(
    annotationsBySegment: Map<number, GuideIssueAnnotation[]>,
    filename: string | null,
    diffIndex: number
  ): DiffOverrides {
    const lineAnnotations = (annotationsBySegment.get(diffIndex) ??
      EMPTY_DIFF_ANNOTATIONS) as DiffLineAnnotation<unknown>[];
    const cached = diffOverrideCache.get(diffIndex);
    if (cached && cached.filename === filename && cached.lineAnnotations === lineAnnotations) {
      return cached.override;
    }

    const canAddIssues = filename != null;
    const override: DiffOverrides = {
      lineAnnotations,
      enableLineSelection: true,
      enableGutterUtility: canAddIssues,
      onGutterUtilityClick: canAddIssues ? getGutterClickHandler(diffIndex, filename) : undefined,
    };
    diffOverrideCache.set(diffIndex, { filename, lineAnnotations, override });
    return override;
  }

  const annotationNodesByIssue = new Map<number, Set<HTMLElement>>();

  let annotationHighlight: AnnotationHighlightHandle | null = null;

  function handleJumpToDiff(issue: ReviewIssueRow) {
    const node = annotationNodesByIssue.get(issue.id)?.values().next().value;
    if (!node) {
      issueActionError = `No annotation rendered for this issue — the line may be outside the diff hunks shown in the guide.`;
      return;
    }
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    annotationHighlight?.cancel();
    annotationHighlight = highlightAnnotationNode(node);
  }

  onDestroy(() => {
    annotationClick.cancel();
    annotationHighlight?.cancel();
    intersectionObserver?.disconnect();
  });

  function annotationNodeAttachment(issueId: number) {
    return (node: HTMLElement) => {
      let nodes = annotationNodesByIssue.get(issueId);
      if (!nodes) {
        nodes = new Set();
        annotationNodesByIssue.set(issueId, nodes);
      }
      nodes.add(node);

      return () => {
        const currentNodes = annotationNodesByIssue.get(issueId);
        currentNodes?.delete(node);
        if (currentNodes?.size === 0) {
          annotationNodesByIssue.delete(issueId);
        }
      };
    };
  }

  // Intersection Observer to track visible sections
  let intersectionObserver: IntersectionObserver | null = null;

  $effect(() => {
    // Clean up previous observer
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }

    // Only set up observer if we have TOC entries
    if (toc.length === 0) return;

    // Create observer with rootMargin to detect when sections are near top
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        // Skip updates if user is currently navigating via the dropdown
        if (isUserNavigating) return;

        // Find the entry that's most visible (highest intersection ratio)
        // and is above the middle of the viewport
        let bestEntry: IntersectionObserverEntry | null = null;
        let bestRatio = 0;

        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > bestRatio) {
            bestEntry = entry;
            bestRatio = entry.intersectionRatio;
          }
        }

        if (bestEntry) {
          const slug = bestEntry.target.id;
          if (slug && slug !== visibleSectionSlug) {
            isProgrammaticUpdate = true;
            visibleSectionSlug = slug;
            // Reset flag after a tick to allow reactivity to settle
            requestAnimationFrame(() => {
              isProgrammaticUpdate = false;
            });
          }
        }
      },
      {
        rootMargin: '-20% 0px -60% 0px', // Trigger when element is in top 20% of viewport
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
      }
    );

    // Observe all heading elements that match TOC slugs
    for (const entry of toc) {
      const el = document.getElementById(entry.slug);
      if (el) {
        intersectionObserver.observe(el);
      }
    }

    return () => {
      intersectionObserver?.disconnect();
    };
  });

  function handleGutterUtilityClick(
    filename: string,
    range: NonNullable<FileDiffOptions<unknown>['onGutterUtilityClick']> extends (
      range: infer T
    ) => unknown
      ? T
      : never
  ) {
    if (newIssueModalState) return;
    const normalized = normalizeGutterRange(range as Parameters<typeof normalizeGutterRange>[0]);
    if (!normalized) {
      // Mixed-side selection (e.g. deletion -> addition). GitHub won't accept
      // such anchors as a single inline comment — skip opening the modal.
      console.warn('Ignoring mixed-side gutter selection', range);
      return;
    }
    newIssueModalState = {
      file: filename,
      startLine: normalized.startLine,
      endLine: normalized.endLine,
      side: normalized.side,
    };
  }

  function closeNewIssueModal() {
    newIssueModalState = null;
  }

  function handleNewIssueSaved(created: ReviewIssueRow) {
    issues = [...issues, created];
  }

  let guideIssueAnnotations = $derived.by(() =>
    stabilizeGuideIssueAnnotations(buildGuideDiffAnnotations(issues, guideSegments))
  );

  // Issue IDs that currently have at least one annotation anchor resolvable
  // from the rendered diffs. Used to gate the "Jump to diff" button so we
  // don't expose a no-op click when the issue's file isn't in the guide or
  // its line doesn't parse to a usable range.
  let issueIdsWithAnnotation = $derived.by(() => {
    const ids = new Set<number>();
    for (const annotations of guideIssueAnnotations.values()) {
      for (const annotation of annotations) {
        ids.add(annotation.metadata.issueId);
      }
    }
    return ids;
  });

  let diffOverrides = $derived.by<DiffOverrideResolver>(() => {
    const annotationsBySegment = guideIssueAnnotations;
    return (
      filename: string | null,
      _patch: string,
      diffIndex: number
    ): DiffOverrides | undefined => {
      return getDiffOverrides(annotationsBySegment, filename, diffIndex);
    };
  });

  function handleTocChange(event: Event) {
    // Skip navigation if this is a programmatic update from Intersection Observer
    if (isProgrammaticUpdate) return;

    const select = event.currentTarget as HTMLSelectElement;
    const slug = select.value;
    if (!slug) return;

    // Set flag to prevent Intersection Observer from interfering during navigation
    isUserNavigating = true;

    const el = document.getElementById(slug);
    el?.scrollIntoView({ behavior: 'instant', block: 'start' });

    // Clear flag after scroll completes (give it some buffer time)
    setTimeout(() => {
      isUserNavigating = false;
    }, 500);
  }

  function guideScrollAttachment(scrollRoot: HTMLElement) {
    const scrollContent = scrollRoot.firstElementChild;
    if (!(scrollContent instanceof HTMLElement)) {
      return;
    }

    const virtualizer = new Virtualizer({
      overscrollSize: 1000,
      intersectionObserverMargin: 4000,
    });
    virtualizer.setup(scrollRoot, scrollContent);
    guideVirtualizer = virtualizer;

    return () => {
      if (guideVirtualizer === virtualizer) {
        guideVirtualizer = null;
      }
      virtualizer.cleanUp();
    };
  }

  function isIssueActioning(issueId: number): boolean {
    return togglingIssueIds.has(issueId);
  }

  function setIssueActioning(issueId: number) {
    togglingIssueIds.add(issueId);
    togglingIssueIds = togglingIssueIds;
  }

  function clearIssueActioning(issueId: number) {
    togglingIssueIds.delete(issueId);
    togglingIssueIds = togglingIssueIds;
  }

  async function handleToggleResolved(issue: ReviewIssueRow) {
    if (isIssueActioning(issue.id)) return;
    issueActionError = null;

    const newResolved = !issue.resolved;
    const newResolvedValue = newResolved ? 1 : 0;
    const previousResolvedValue = newResolved ? 0 : 1;
    issues = issues.map((row) =>
      row.id === issue.id ? { ...row, resolved: newResolvedValue } : row
    );
    setIssueActioning(issue.id);

    try {
      await toggleReviewIssueResolved({ issueId: issue.id, resolved: newResolved });
    } catch (err) {
      issues = issues.map((row) =>
        row.id === issue.id ? { ...row, resolved: previousResolvedValue } : row
      );
      issueActionError = extractRemoteErrorMessage(err);
      await invalidateAll();
    } finally {
      clearIssueActioning(issue.id);
    }
  }

  async function handleDeleteIssue(issue: ReviewIssueRow) {
    if (isIssueActioning(issue.id)) return;
    issueActionError = null;
    const previousIssues = issues;
    issues = issues.filter((row) => row.id !== issue.id);
    setIssueActioning(issue.id);

    try {
      await deleteReviewIssue({ reviewId: data.review.id, issueId: issue.id });
    } catch (err) {
      issues = previousIssues;
      issueActionError = extractRemoteErrorMessage(err);
    } finally {
      clearIssueActioning(issue.id);
    }
  }

  async function handleAddIssueToPlan(issue: ReviewIssueRow) {
    if (isIssueActioning(issue.id) || !linkedPlanUuid) return;
    issueActionError = null;
    setIssueActioning(issue.id);

    try {
      await addReviewIssueToPlanTask({
        reviewId: data.review.id,
        issueId: issue.id,
        planUuid: linkedPlanUuid,
      });
      await invalidateAll();
    } catch (err) {
      issueActionError = extractRemoteErrorMessage(err);
    } finally {
      clearIssueActioning(issue.id);
    }
  }

  const handleSaveEdit = createSaveEditHandler({
    getIssues: () => issues,
    setIssues: (next) => {
      issues = next;
    },
    setError: (message) => {
      issueActionError = message;
    },
    updateRemote: ({ issueId, patch }) => updateReviewIssueFields({ issueId, patch }),
  });

  function issueLocationLabel(issue: ReviewIssueRow): string | null {
    if (!issue.file) return null;

    const line =
      issue.start_line && issue.line && issue.start_line !== issue.line
        ? `${issue.start_line}–${issue.line}`
        : (issue.line ?? issue.start_line);

    return line ? `${issue.file}:${line}` : issue.file;
  }

  function severityBadgeClass(severity: ReviewSeverity): string {
    switch (severity) {
      case 'critical':
        return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
      case 'major':
        return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
      case 'minor':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
      case 'info':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
    }
  }

  function categoryBadgeClass(_category: ReviewCategory): string {
    return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }

  function statusBadgeClass(status: string): string {
    switch (status) {
      case 'complete':
        return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
      case 'in_progress':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
      case 'error':
        return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
      default:
        return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
    }
  }

  function statusLabel(status: string): string {
    switch (status) {
      case 'complete':
        return 'Complete';
      case 'in_progress':
        return 'In Progress';
      case 'error':
        return 'Error';
      default:
        return 'Pending';
    }
  }

  function formatCategory(category: ReviewCategory): string {
    switch (category) {
      case 'security':
        return 'Security';
      case 'performance':
        return 'Performance';
      case 'bug':
        return 'Bug';
      case 'style':
        return 'Style';
      case 'compliance':
        return 'Compliance';
      case 'testing':
        return 'Testing';
      case 'other':
        return 'Other';
    }
  }

  function formatSeverity(severity: ReviewSeverity): string {
    return severity.charAt(0).toUpperCase() + severity.slice(1);
  }

  function shortSha(sha: string | null): string {
    return sha ? sha.slice(0, 7) : '';
  }
</script>

<div
  class="flex h-full flex-col overflow-hidden px-6 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
  aria-label="Review guide detail"
>
  <!-- Top: back link, header, metadata, alerts -->
  <div class="mb-4 shrink-0 space-y-3 pt-6">
    <a
      href="/projects/{projectId}/prs/{prNumber}"
      class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft class="size-3.5" />
      Back to PR #{prNumber}
    </a>

    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-semibold text-foreground">Review Guide</h2>
          {#if toc.length > 0}
            <select
              aria-label="Jump to section"
              class="w-auto max-w-[32rem] rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
              bind:value={visibleSectionSlug}
              onchange={handleTocChange}
            >
              <option value="">Jump to section…</option>
              {#each toc as entry (entry.slug)}
                <option value={entry.slug}>
                  {'\u00A0\u00A0'.repeat(Math.max(0, entry.depth - 1))}{entry.text}
                </option>
              {/each}
            </select>
          {/if}
        </div>
        <div class="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
          <span class="min-w-0 truncate">{data.review.branch}</span>
          <CopyButton
            text={data.review.branch ?? ''}
            disabled={!data.review.branch}
            mode="icon"
            iconClass="size-3"
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
            title="Copy branch name"
            ariaLabel="Copy branch name"
          />
          {#if data.review.base_branch}
            <span class="text-foreground/50"> → {data.review.base_branch}</span>
          {/if}
        </div>
      </div>
      <span
        class="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium {statusBadgeClass(
          data.review.status
        )}"
      >
        {statusLabel(data.review.status)}
      </span>
      {#if data.review.status === 'complete'}
        <button
          type="button"
          onclick={openSubmitDialog}
          class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <Send class="size-3" />
          Submit Review
        </button>
      {/if}
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span title={data.review.created_at}>
        Generated {formatRelativeTime(data.review.created_at)}
      </span>
      {#if data.review.reviewed_sha}
        <span class="font-mono">SHA: {shortSha(data.review.reviewed_sha)}</span>
      {/if}
      {#if data.review.status === 'complete'}
        <span
          >{issues.length} issue{issues.length === 1 ? '' : 's'} ({unresolvedCount} unresolved)</span
        >
      {/if}
    </div>

    {#if hasNewCommits}
      <div
        class="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <span>
          New commits have been pushed since this review was generated (reviewed
          <span class="font-mono">{shortSha(data.review.reviewed_sha)}</span>, current HEAD
          <span class="font-mono">{shortSha(data.currentHeadSha)}</span>).
        </span>
      </div>
    {/if}

    {#if data.review.status === 'error' && data.review.error_message}
      <div
        class="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300"
      >
        {data.review.error_message}
      </div>
    {/if}

    {#if issueActionError}
      <div
        class="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300"
      >
        {issueActionError}
      </div>
    {/if}
  </div>

  <!-- Split: guide left, issues right -->
  <Splitpanes theme="tim-split" class="min-h-0 flex-1 pb-6">
    <!-- Left: review guide -->
    <Pane minSize={20}>
      <div class="h-full overflow-y-auto pr-1" {@attach guideScrollAttachment}>
        <div>
          {#if data.review.review_guide}
            <MarkdownContent
              content={data.review.review_guide}
              class="text-sm text-foreground"
              {diffOverrides}
              virtualizer={guideVirtualizer}
            >
              {#snippet diffAnnotation(annotation)}
                {@const metadata = annotation.metadata as ReviewIssueAnnotationMetadata | undefined}
                {#if metadata}
                  <div {@attach annotationNodeAttachment(metadata.issueId)}>
                    <ReviewIssueAnnotation
                      issueId={metadata.issueId}
                      severity={metadata.severity}
                      content={metadata.content}
                      suggestion={metadata.suggestion}
                      lineLabel={metadata.lineLabel}
                      onClick={annotationClick.handleAnnotationClick}
                    />
                  </div>
                {/if}
              {/snippet}
            </MarkdownContent>
          {:else if data.review.status !== 'complete'}
            <p class="text-sm text-muted-foreground">Review guide not yet available.</p>
          {/if}
        </div>
      </div>
    </Pane>

    <!-- Right: issues -->
    <Pane size={30} minSize={15}>
      <div class="@container h-full space-y-1.5 overflow-y-auto pl-3">
        <h3
          class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase @sm:text-sm"
        >
          Issues
          {#if issues.length > 0}
            <span class="ml-1 font-normal normal-case">
              ({unresolvedCount} of {issues.length} unresolved)
            </span>
          {/if}
        </h3>

        {#if issues.length > 0}
          {#each SEVERITY_ORDER as severity (severity)}
            {@const severityIssues = groupedIssues.get(severity) ?? []}
            {#if severityIssues.length > 0}
              <details open class="group">
                <summary
                  class="flex cursor-pointer list-none items-center gap-2 rounded px-1 py-1 hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <span
                    class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium @sm:text-sm {severityBadgeClass(
                      severity
                    )}"
                  >
                    {formatSeverity(severity)}
                  </span>
                  <span class="text-xs text-muted-foreground @sm:text-sm">
                    {severityIssues.filter((i) => !i.resolved).length}/{severityIssues.length} open
                  </span>
                </summary>
                <ul class="mt-1 space-y-1.5 pl-1">
                  {#each severityIssues as issue (issue.id)}
                    <ReviewIssueCard
                      {issue}
                      rootId="review-issue-{issue.id}"
                      highlighted={highlightedIssueId === issue.id}
                      actioning={isIssueActioning(issue.id)}
                      {linkedPlanUuid}
                      submission={issue.submittedInPrReviewId != null
                        ? (submissionsById.get(issue.submittedInPrReviewId) ?? null)
                        : null}
                      {categoryBadgeClass}
                      {issueLocationLabel}
                      {formatCategory}
                      onToggleResolved={handleToggleResolved}
                      onDelete={handleDeleteIssue}
                      onAddToPlan={handleAddIssueToPlan}
                      onSaveEdit={handleSaveEdit}
                      onJumpToDiff={issueIdsWithAnnotation.has(issue.id)
                        ? handleJumpToDiff
                        : undefined}
                      onCopyError={(message) => (issueActionError = message)}
                    />
                  {/each}
                </ul>
              </details>
            {/if}
          {/each}
        {:else if data.review.status === 'complete'}
          <p class="text-xs text-muted-foreground @sm:text-sm">No issues found.</p>
        {/if}
      </div>
    </Pane>
  </Splitpanes>

  {#if submitDialogOpen}
    <SubmitReviewDialog
      open={true}
      reviewId={data.review.id}
      reviewedSha={data.review.reviewed_sha}
      currentHeadSha={data.currentHeadSha}
      {issues}
      onClose={closeSubmitDialog}
      onSubmitted={handleSubmitted}
    />
  {/if}

  {#if newIssueModalState}
    <NewReviewIssueModal
      open={true}
      reviewId={data.review.id}
      file={newIssueModalState.file}
      startLine={newIssueModalState.startLine}
      endLine={newIssueModalState.endLine}
      side={newIssueModalState.side}
      onSaved={handleNewIssueSaved}
      onClose={closeNewIssueModal}
    />
  {/if}
</div>
