<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import type { DiffLineAnnotation, FileDiffOptions } from '@pierre/diffs';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
  import Columns2 from '@lucide/svelte/icons/columns-2';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Rows2 from '@lucide/svelte/icons/rows-2';
  import { onDestroy, onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { toggleReviewIssueResolved } from '$lib/remote/pr_reviews.remote.js';
  import {
    addReviewIssueToPlanTask,
    deleteReviewIssue,
  } from '$lib/remote/review_issue_actions.remote.js';
  import { updateReviewIssueFields } from '$lib/remote/pr_review_submission.remote.js';
  import CopyButton from '$lib/components/CopyButton.svelte';
  import MarkdownContent, { type DiffOverrides } from '$lib/components/MarkdownContent.svelte';
  import PrReviewThreadList from '$lib/components/PrReviewThreadList.svelte';
  import { computeReviewGuideDiffOverrideFlags } from '$lib/components/review_guide_view_utils.js';
  import { parseMarkdownWithDiffsAndToc, type TocEntry } from '$lib/utils/markdown_parser.js';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import { buildLinearReviewDeepLink } from '$lib/utils/linear_review_deep_link.js';
  import { Splitpanes, Pane } from 'svelte-splitpanes';
  import type {
    ReviewRow,
    ReviewIssueRow,
    ReviewSeverity,
    ReviewCategory,
    PrReviewSubmissionRow,
  } from '$tim/db/review.js';
  import type { LinkedPlanSummary, PrReviewThreadDetail } from '$tim/db/pr_status.js';
  import Send from '@lucide/svelte/icons/send';
  import {
    buildGuideDiffAnnotations,
    extractDiffLineRanges,
    type ReviewIssueAnnotationData,
  } from '../../routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/review_detail_utils.js';
  import ReviewIssueCard from '../../routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/ReviewIssueCard.svelte';
  import ReviewIssueAnnotation from '../../routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/ReviewIssueAnnotation.svelte';
  import ReviewGuideLinkedPlans from '../../routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/ReviewGuideLinkedPlans.svelte';
  import type { ReviewIssueAnnotationMetadata } from '../../routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/annotation_types.js';
  import NewReviewIssueModal from '../../routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/NewReviewIssueModal.svelte';
  import SubmitReviewDialog from '../../routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/SubmitReviewDialog.svelte';
  import { normalizeGutterRange } from '../../routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/new_issue_modal_utils.js';
  import { extractRemoteErrorMessage } from '../../routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/remote_error.js';
  import {
    highlightAnnotationNode,
    type AnnotationHighlightHandle,
  } from '../../routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/annotation_highlight.js';
  import { getReviewGuideAnnotationId, getReviewGuideDiffId } from '$lib/utils/review_diff_ids.js';
  import {
    createSaveEditHandler,
    createAnnotationClickHandler,
    createJumpToDiffHandler,
    runTrackedAsyncAction,
    type ApproximateAnnotationPosition,
  } from '../../routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/page_handlers.js';

  type GuideDiffStyle = 'unified' | 'split';
  const DIFF_STYLE_STORAGE_KEY = 'tim.reviewGuide.diffStyle';

  interface Props {
    review: ReviewRow;
    issues: ReviewIssueRow[];
    projectId: string;
    backHref: string;
    backLabel: string;
    allowGithubSubmission?: boolean;
    submissions?: PrReviewSubmissionRow[];
    linkedPlans?: LinkedPlanSummary[];
    linkedPlanUuid?: string | null;
    currentBranch?: string | null;
    currentHeadSha?: string | null;
    submissionPrUrl?: string | null;
    submitAsCommentOnly?: boolean;
    reviewThreads?: PrReviewThreadDetail[];
  }

  let {
    review,
    issues: issuesInput,
    projectId,
    backHref,
    backLabel,
    allowGithubSubmission = false,
    submissions: submissionsInput = [],
    linkedPlans = [],
    linkedPlanUuid: linkedPlanUuidInput = null,
    currentBranch = null,
    currentHeadSha = null,
    submissionPrUrl = null,
    submitAsCommentOnly = false,
    reviewThreads = [],
  }: Props = $props();

  // Local state for optimistic issue updates. $derived is writable in Svelte 5,
  // so optimistic mutations work directly and the list auto-refreshes when
  // input updates (e.g. after invalidateAll).
  let issues = $derived(issuesInput.map((i) => ({ ...i })));

  let submissions = $derived<PrReviewSubmissionRow[]>(submissionsInput);
  let submissionsById = $derived(
    new Map<number, PrReviewSubmissionRow>(submissions.map((s) => [s.id, s]))
  );

  let submitDialogOpen = $state(false);
  let guideDiffStyle = $state<GuideDiffStyle>('unified');

  function parseStoredDiffStyle(value: string | null): GuideDiffStyle | null {
    return value === 'unified' || value === 'split' ? value : null;
  }

  function setGuideDiffStyle(style: GuideDiffStyle): void {
    guideDiffStyle = style;
    localStorage.setItem(DIFF_STYLE_STORAGE_KEY, style);
  }

  onMount(() => {
    const storedStyle = parseStoredDiffStyle(localStorage.getItem(DIFF_STYLE_STORAGE_KEY));
    if (storedStyle) {
      guideDiffStyle = storedStyle;
    }
  });

  function openSubmitDialog() {
    submitDialogOpen = true;
  }

  function closeSubmitDialog() {
    submitDialogOpen = false;
  }

  async function handleSubmitted() {
    await invalidateAll();
  }

  let togglingIssueIds = $state(new Set<number>());
  let issueActionError = $state<string | null>(null);

  const SEVERITY_ORDER: ReviewSeverity[] = ['critical', 'major', 'minor', 'info', 'note'];

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
    currentHeadSha != null &&
      review.reviewed_sha != null &&
      currentHeadSha !== review.reviewed_sha &&
      review.status === 'complete'
  );

  let unresolvedCount = $derived(issues.filter((i) => i.severity !== 'note' && !i.resolved).length);
  let actionableIssueCount = $derived(issues.filter((i) => i.severity !== 'note').length);
  let linkedPlanUuid = $derived(linkedPlanUuidInput);
  let linkedPlanBranch = $derived.by(() => {
    if (!linkedPlanUuid) {
      return linkedPlans.length === 1 ? (linkedPlans[0]?.branch ?? null) : null;
    }
    return linkedPlans.find((plan) => plan.planUuid === linkedPlanUuid)?.branch ?? null;
  });
  let displayBranch = $derived(currentBranch ?? review.branch ?? linkedPlanBranch);
  let effectivePrUrl = $derived(review.pr_url ?? submissionPrUrl);
  let linearPrReviewUrl = $derived(buildLinearReviewDeepLink({ prUrl: effectivePrUrl }));

  let reviewGuideText = $derived(review.review_guide ?? '');
  let parsedGuide = $derived(parseMarkdownWithDiffsAndToc(reviewGuideText));
  let toc = $derived<TocEntry[]>(parsedGuide.toc);
  let guideSegments = $derived(parsedGuide.segments);

  let visibleSectionSlug = $state<string>('');
  let isUserNavigating = $state(false);
  let sectionSidebar = $state<HTMLElement | null>(null);

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
      patch: string | null;
      diffStyle: GuideDiffStyle;
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
      a.metadata.lineLabel === b.metadata.lineLabel &&
      a.metadata.resolved === b.metadata.resolved
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
    diffIndex: number,
    diffStyle: GuideDiffStyle
  ): DiffOverrides {
    const lineAnnotations = (annotationsBySegment.get(diffIndex) ??
      EMPTY_DIFF_ANNOTATIONS) as DiffLineAnnotation<unknown>[];
    const cached = diffOverrideCache.get(diffIndex);
    if (
      cached &&
      cached.filename === filename &&
      cached.diffStyle === diffStyle &&
      cached.lineAnnotations === lineAnnotations &&
      cached.patch ===
        (guideSegments[diffIndex]?.type === 'unified-diff' ? guideSegments[diffIndex].patch : null)
    ) {
      return cached.override;
    }

    const patch =
      guideSegments[diffIndex]?.type === 'unified-diff' ? guideSegments[diffIndex].patch : null;
    const flags = computeReviewGuideDiffOverrideFlags(filename);
    const override: DiffOverrides = {
      id: getReviewGuideDiffId(filename, patch ?? ''),
      diffStyle,
      stickyHeader: true,
      lineAnnotations,
      enableLineSelection: flags.enableLineSelection,
      enableGutterUtility: flags.enableGutterUtility,
      onGutterUtilityClick:
        flags.exposeGutterClick && filename != null
          ? getGutterClickHandler(diffIndex, filename)
          : undefined,
    };
    diffOverrideCache.set(diffIndex, {
      filename,
      patch,
      diffStyle,
      lineAnnotations,
      override,
    });
    return override;
  }

  const annotationNodesByIssue = new Map<number, Set<HTMLElement>>();

  function getAnnotationNode(issueId: number): HTMLElement | null {
    const nodes = annotationNodesByIssue.get(issueId);
    if (!nodes) {
      return null;
    }

    for (const node of nodes) {
      if (node.isConnected) {
        return node;
      }
      nodes.delete(node);
    }

    if (nodes.size === 0) {
      annotationNodesByIssue.delete(issueId);
    }
    return null;
  }

  let annotationHighlight: AnnotationHighlightHandle | null = null;

  function queryLineNode(root: ParentNode, lineNumber: number): HTMLElement | null {
    const selector = `[data-line="${lineNumber}"]`;
    const direct = root.querySelector(selector);
    if (direct instanceof HTMLElement) {
      return direct;
    }

    const diffHosts: HTMLElement[] = [];
    if (root instanceof HTMLElement && root.matches('diffs-container')) {
      diffHosts.push(root);
    }
    diffHosts.push(...root.querySelectorAll<HTMLElement>('diffs-container'));

    for (const host of diffHosts) {
      const nested = host.shadowRoot?.querySelector(selector);
      if (nested instanceof HTMLElement) {
        return nested;
      }
    }

    return null;
  }

  function getGuideDiffTarget(issueId: number): {
    filename: string;
    patch: string;
    lineNumber: number;
    side: GuideIssueAnnotation['side'];
  } | null {
    for (const [diffIndex, annotations] of guideIssueAnnotations) {
      const annotation = annotations.find((annotation) => annotation.metadata.issueId === issueId);
      if (!annotation) {
        continue;
      }

      const segment = guideSegments[diffIndex];
      if (segment?.type === 'unified-diff' && segment.filename) {
        return {
          filename: segment.filename,
          patch: segment.patch,
          lineNumber: annotation.lineNumber,
          side: annotation.side,
        };
      }
    }
    return null;
  }

  function getApproximateLinePosition(
    patch: string,
    lineNumber: number,
    side: GuideIssueAnnotation['side']
  ): ApproximateAnnotationPosition | null {
    const hunkHeaderRegex = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    let lineIndex = 0;
    let targetLineIndex: number | null = null;

    for (const patchLine of patch.split('\n')) {
      const hunkMatch = hunkHeaderRegex.exec(patchLine);
      if (hunkMatch) {
        oldLine = Number.parseInt(hunkMatch[1], 10);
        newLine = Number.parseInt(hunkMatch[2], 10);
        inHunk = true;
        continue;
      }

      if (!inHunk || patchLine.startsWith('\\')) {
        continue;
      }

      const marker = patchLine[0];
      let matchesTargetLine = false;

      if (marker === '+') {
        matchesTargetLine = side === 'additions' && newLine === lineNumber;
        newLine += 1;
      } else if (marker === '-') {
        matchesTargetLine = side === 'deletions' && oldLine === lineNumber;
        oldLine += 1;
      } else if (marker === ' ') {
        matchesTargetLine =
          (side === 'additions' && newLine === lineNumber) ||
          (side === 'deletions' && oldLine === lineNumber);
        oldLine += 1;
        newLine += 1;
      } else {
        continue;
      }

      if (matchesTargetLine && targetLineIndex === null) {
        targetLineIndex = lineIndex;
      }
      lineIndex += 1;
    }

    if (targetLineIndex === null || lineIndex === 0) {
      return null;
    }

    return {
      lineIndex: targetLineIndex,
      totalLines: lineIndex,
    };
  }

  function getDiffNodeForIssue(issueId: number): HTMLElement | null {
    const diffTarget = getGuideDiffTarget(issueId);
    if (diffTarget === null) {
      return null;
    }

    return document.getElementById(getReviewGuideDiffId(diffTarget.filename, diffTarget.patch));
  }

  function getAnnotationLineNode(issueId: number): HTMLElement | null {
    const diffTarget = getGuideDiffTarget(issueId);
    if (diffTarget === null) {
      return null;
    }

    const diffNode = document.getElementById(
      getReviewGuideDiffId(diffTarget.filename, diffTarget.patch)
    );
    if (!diffNode) {
      return null;
    }

    return queryLineNode(diffNode, diffTarget.lineNumber);
  }

  function getApproximateAnnotationPosition(issueId: number): ApproximateAnnotationPosition | null {
    const diffTarget = getGuideDiffTarget(issueId);
    if (diffTarget === null) {
      return null;
    }

    return getApproximateLinePosition(diffTarget.patch, diffTarget.lineNumber, diffTarget.side);
  }

  const handleJumpToDiff = createJumpToDiffHandler({
    getAnnotationNode,
    getAnnotationLineNode,
    getApproximateAnnotationPosition,
    getDiffNode: getDiffNodeForIssue,
    setHighlightedAnnotation: (node) => {
      annotationHighlight?.cancel();
      annotationHighlight = highlightAnnotationNode(node);
    },
    setError: (message) => {
      issueActionError = message;
    },
  });

  interface GuideReviewThreadTarget {
    filename: string;
    patch: string;
    lineNumber: number;
    side: GuideIssueAnnotation['side'];
  }

  function getGuideReviewThreadTarget(threadId: number): GuideReviewThreadTarget | null {
    return reviewThreadDiffTargets.get(threadId) ?? null;
  }

  function getDiffNodeForReviewThread(threadId: number): HTMLElement | null {
    const diffTarget = getGuideReviewThreadTarget(threadId);
    if (diffTarget === null) {
      return null;
    }

    return document.getElementById(getReviewGuideDiffId(diffTarget.filename, diffTarget.patch));
  }

  function getReviewThreadLineNode(threadId: number): HTMLElement | null {
    const diffTarget = getGuideReviewThreadTarget(threadId);
    if (diffTarget === null) {
      return null;
    }

    const diffNode = document.getElementById(
      getReviewGuideDiffId(diffTarget.filename, diffTarget.patch)
    );
    if (!diffNode) {
      return null;
    }

    return queryLineNode(diffNode, diffTarget.lineNumber);
  }

  function getApproximateReviewThreadPosition(
    threadId: number
  ): ApproximateAnnotationPosition | null {
    const diffTarget = getGuideReviewThreadTarget(threadId);
    if (diffTarget === null) {
      return null;
    }

    return getApproximateLinePosition(diffTarget.patch, diffTarget.lineNumber, diffTarget.side);
  }

  const handleJumpToReviewThreadDiff = createJumpToDiffHandler({
    getAnnotationNode: () => null,
    getAnnotationLineNode: getReviewThreadLineNode,
    getApproximateAnnotationPosition: getApproximateReviewThreadPosition,
    getDiffNode: getDiffNodeForReviewThread,
    setHighlightedAnnotation: () => {},
    setError: (message) => {
      issueActionError = message?.replaceAll('annotation', 'review thread') ?? null;
    },
  });

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

  let intersectionObserver: IntersectionObserver | null = null;

  $effect(() => {
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }

    if (toc.length === 0) return;

    intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (isUserNavigating) return;

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
            visibleSectionSlug = slug;
          }
        }
      },
      {
        rootMargin: '-20% 0px -60% 0px',
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
      }
    );

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

  // Keep the highlighted section visible within the (independently scrollable) sidebar.
  $effect(() => {
    const slug = visibleSectionSlug;
    if (!slug || !sectionSidebar) return;
    const activeItem = sectionSidebar.querySelector<HTMLElement>(
      `[data-section-slug="${CSS.escape(slug)}"]`
    );
    activeItem?.scrollIntoView({ block: 'nearest' });
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
    const currentDiffStyle = guideDiffStyle;
    return (
      filename: string | null,
      _patch: string,
      diffIndex: number
    ): DiffOverrides | undefined => {
      return getDiffOverrides(annotationsBySegment, filename, diffIndex, currentDiffStyle);
    };
  });

  function handleTocSelect(slug: string) {
    if (!slug) return;

    isUserNavigating = true;
    visibleSectionSlug = slug;

    const el = document.getElementById(slug);
    el?.scrollIntoView({ behavior: 'instant', block: 'start' });

    setTimeout(() => {
      isUserNavigating = false;
    }, 500);
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
    const previousIssues = issues;
    await runTrackedAsyncAction({
      setError: (message) => {
        issueActionError = message;
      },
      setBusy: () => {
        issues = issues.filter((row) => row.id !== issue.id);
        setIssueActioning(issue.id);
      },
      clearBusy: () => {
        clearIssueActioning(issue.id);
      },
      action: async () => {
        try {
          await deleteReviewIssue({ reviewId: review.id, issueId: issue.id });
        } catch (err) {
          issues = previousIssues;
          throw err;
        }
      },
    });
  }

  async function handleAddIssueToPlan(issue: ReviewIssueRow) {
    if (isIssueActioning(issue.id) || !linkedPlanUuid) return;
    await runTrackedAsyncAction({
      setError: (message) => {
        issueActionError = message;
      },
      setBusy: () => {
        setIssueActioning(issue.id);
      },
      clearBusy: () => {
        clearIssueActioning(issue.id);
      },
      action: async () => {
        await addReviewIssueToPlanTask({
          reviewId: review.id,
          issueId: issue.id,
          planUuid: linkedPlanUuid!,
        });
        toast.success('Added review issue to plan as a task');
      },
      afterSuccess: async () => {
        await invalidateAll();
      },
    });
  }

  const handleSaveEdit = createSaveEditHandler({
    getIssues: () => issues,
    setIssues: (next) => {
      issues = next;
    },
    setError: (message) => {
      issueActionError = message;
    },
    updateRemote: async ({ issueId, patch }) => await updateReviewIssueFields({ issueId, patch }),
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
      case 'note':
        return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
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
    if (severity === 'note') return 'Notes';
    return severity.charAt(0).toUpperCase() + severity.slice(1);
  }

  function shortSha(sha: string | null): string {
    return sha ? sha.slice(0, 7) : '';
  }

  function threadDisplayLine(thread: PrReviewThreadDetail): number | null {
    const row = thread.thread;
    return row.line ?? row.original_line ?? row.start_line ?? row.original_start_line;
  }

  function threadStartLine(thread: PrReviewThreadDetail): number | null {
    const row = thread.thread;
    return row.start_line ?? row.original_start_line ?? row.line ?? row.original_line;
  }

  function threadSide(thread: PrReviewThreadDetail): 'additions' | 'deletions' {
    return thread.thread.diff_side === 'LEFT' ? 'deletions' : 'additions';
  }

  function diffContainsThread(
    filename: string | null,
    patch: string,
    thread: PrReviewThreadDetail
  ): boolean {
    if (filename == null || thread.thread.path !== filename) {
      return false;
    }

    const line = threadDisplayLine(thread);
    const startLine = threadStartLine(thread);
    if (line == null || startLine == null) {
      return false;
    }

    const side = threadSide(thread);
    const start = Math.min(startLine, line);
    const end = Math.max(startLine, line);
    return extractDiffLineRanges(patch, filename).some(
      (range) => range.side === side && start <= range.end && end >= range.start
    );
  }

  function reviewThreadsForDiff(filename: string | null, patch: string): PrReviewThreadDetail[] {
    return reviewThreads.filter((thread) => diffContainsThread(filename, patch, thread));
  }

  let reviewThreadDiffTargets = $derived.by(() => {
    const targets = new Map<number, GuideReviewThreadTarget>();
    for (const segment of guideSegments) {
      if (segment.type !== 'unified-diff') {
        continue;
      }

      for (const thread of reviewThreads) {
        if (
          targets.has(thread.thread.id) ||
          !diffContainsThread(segment.filename, segment.patch, thread)
        ) {
          continue;
        }

        const line = threadDisplayLine(thread);
        if (segment.filename == null || line == null) {
          continue;
        }

        targets.set(thread.thread.id, {
          filename: segment.filename,
          patch: segment.patch,
          lineNumber: line,
          side: threadSide(thread),
        });
      }
    }
    return targets;
  });

  let matchedReviewThreads = $derived(
    reviewThreads.filter((thread) => reviewThreadDiffTargets.has(thread.thread.id))
  );

  let unresolvedReviewThreadCount = $derived(
    matchedReviewThreads.filter((thread) => !thread.thread.is_resolved).length
  );

  function reviewThreadGithubLink(thread: PrReviewThreadDetail): string {
    const databaseId = thread.comments.find((comment) => comment.database_id != null)?.database_id;
    if (databaseId && effectivePrUrl) {
      return `${effectivePrUrl}#discussion_r${databaseId}`;
    }
    return effectivePrUrl ?? '#';
  }

  function reviewThreadLocationLabel(thread: PrReviewThreadDetail): string {
    const line = threadDisplayLine(thread);
    return line != null ? `${thread.thread.path}:${line}` : thread.thread.path;
  }

  function reviewThreadSummary(thread: PrReviewThreadDetail): string {
    const firstBody = thread.comments.find((comment) => comment.body?.trim())?.body?.trim();
    return firstBody ?? 'No comment body.';
  }
</script>

<div
  class="flex h-full flex-col overflow-hidden px-6 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
  aria-label="Review guide detail"
>
  <!-- Top: back link, header, metadata, alerts -->
  <div class="mb-4 shrink-0 space-y-3 pt-6">
    <a
      href={backHref}
      class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft class="size-3.5" />
      {backLabel}
    </a>

    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-semibold text-foreground">Review Guide</h2>
          <div
            class="inline-flex shrink-0 overflow-hidden rounded-md border border-border bg-background"
            aria-label="Diff layout"
          >
            <button
              type="button"
              class="inline-flex h-8 items-center gap-1.5 px-2.5 text-xs font-medium transition-colors {guideDiffStyle ===
              'unified'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
              aria-pressed={guideDiffStyle === 'unified'}
              title="Stacked diff layout"
              onclick={() => {
                setGuideDiffStyle('unified');
              }}
            >
              <Rows2 class="size-3.5" />
              Stacked
            </button>
            <button
              type="button"
              class="inline-flex h-8 items-center gap-1.5 border-l border-border px-2.5 text-xs font-medium transition-colors {guideDiffStyle ===
              'split'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
              aria-pressed={guideDiffStyle === 'split'}
              title="Side-by-side diff layout"
              onclick={() => {
                setGuideDiffStyle('split');
              }}
            >
              <Columns2 class="size-3.5" />
              Side by side
            </button>
          </div>
        </div>
        {#if displayBranch}
          <div class="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
            <span class="min-w-0 truncate">{displayBranch}</span>
            <CopyButton
              text={displayBranch ?? ''}
              disabled={!displayBranch}
              mode="icon"
              iconClass="size-3"
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
              title="Copy branch name"
              ariaLabel="Copy branch name"
            />
            {#if review.base_branch}
              <span class="text-foreground/50"> → {review.base_branch}</span>
            {/if}
          </div>
        {:else if review.base_branch}
          <div class="mt-0.5 text-sm text-muted-foreground">
            Base: <span class="font-mono">{review.base_branch}</span>
          </div>
        {/if}
        {#if allowGithubSubmission}
          <div class="mt-2">
            <ReviewGuideLinkedPlans {projectId} {linkedPlans} />
          </div>
        {/if}
      </div>
      <span
        class="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium {statusBadgeClass(
          review.status
        )}"
      >
        {statusLabel(review.status)}
      </span>
      {#if allowGithubSubmission && review.status === 'complete'}
        <button
          type="button"
          onclick={openSubmitDialog}
          class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <Send class="size-3" />
          Submit Review
        </button>
      {/if}
      {#if effectivePrUrl}
        <a
          href={effectivePrUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
          title="View in GitHub"
        >
          <ExternalLink class="size-3" />
          View in GitHub
        </a>
      {/if}
      {#if linearPrReviewUrl}
        <a
          href={linearPrReviewUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
          title="View in Linear"
        >
          <ExternalLink class="size-3" />
          View in Linear
        </a>
      {/if}
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span title={review.created_at}>
        Generated {formatRelativeTime(review.created_at)}
      </span>
      {#if review.reviewed_sha}
        <span class="font-mono">SHA: {shortSha(review.reviewed_sha)}</span>
      {/if}
      {#if review.status === 'complete'}
        <span
          >{actionableIssueCount} issue{actionableIssueCount === 1 ? '' : 's'} ({unresolvedCount} unresolved)</span
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
          <span class="font-mono">{shortSha(review.reviewed_sha)}</span>, current HEAD
          <span class="font-mono">{shortSha(currentHeadSha)}</span>).
        </span>
      </div>
    {/if}

    {#if review.status === 'error' && review.error_message}
      <div
        class="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300"
      >
        {review.error_message}
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
    <Pane minSize={20}>
      <div class="flex h-full min-h-0 gap-3">
        {#if toc.length > 0}
          <nav
            bind:this={sectionSidebar}
            aria-label="Review guide sections"
            class="w-72 shrink-0 overflow-y-auto border-r border-border pr-2"
          >
            <ul class="space-y-0.5 py-0.5">
              {#each toc as entry (entry.slug)}
                <li>
                  <button
                    type="button"
                    data-section-slug={entry.slug}
                    onclick={() => handleTocSelect(entry.slug)}
                    style="padding-left: {0.5 + Math.max(0, entry.depth - 1) * 0.75}rem"
                    class="block w-full rounded py-1 pr-2 text-left text-sm transition-colors {visibleSectionSlug ===
                    entry.slug
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
                    aria-current={visibleSectionSlug === entry.slug ? 'true' : undefined}
                    title={entry.text}
                  >
                    {entry.text}
                  </button>
                </li>
              {/each}
            </ul>
          </nav>
        {/if}
        <div class="min-w-0 flex-1 overflow-y-auto pr-1">
          {#if review.review_guide}
            <MarkdownContent
              content={review.review_guide}
              parsedSegments={guideSegments}
              class="text-sm text-foreground"
              {diffOverrides}
            >
              {#snippet diffAnnotation(annotation)}
                {@const metadata = annotation.metadata as ReviewIssueAnnotationMetadata | undefined}
                {#if metadata}
                  <div
                    id={getReviewGuideAnnotationId(metadata.issueId)}
                    {@attach annotationNodeAttachment(metadata.issueId)}
                  >
                    <ReviewIssueAnnotation
                      issueId={metadata.issueId}
                      severity={metadata.severity}
                      content={metadata.content}
                      suggestion={metadata.suggestion}
                      lineLabel={metadata.lineLabel}
                      resolved={metadata.resolved}
                      onClick={annotationClick.handleAnnotationClick}
                    />
                  </div>
                {/if}
              {/snippet}
              {#snippet diffFooter(filename, patch, _diffIndex)}
                {@const diffReviewThreads = reviewThreadsForDiff(filename, patch)}
                {#if allowGithubSubmission && review.pr_url && diffReviewThreads.length > 0}
                  <div class="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
                    <div
                      class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                    >
                      Existing review thread{diffReviewThreads.length === 1 ? '' : 's'}
                    </div>
                    <PrReviewThreadList
                      threads={diffReviewThreads}
                      prUrl={review.pr_url}
                      planUuid={linkedPlanUuid ?? undefined}
                      expandMode="expanded"
                      showDiff={false}
                    />
                  </div>
                {/if}
              {/snippet}
            </MarkdownContent>
          {:else if review.status !== 'complete'}
            <p class="text-sm text-muted-foreground">Review guide not yet available.</p>
          {/if}
        </div>
      </div>
    </Pane>

    <Pane size={30} minSize={15}>
      <div class="@container h-full space-y-1.5 overflow-y-auto pl-3">
        <h3
          class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase @sm:text-sm"
        >
          Issues
          {#if actionableIssueCount > 0}
            <span class="ml-1 font-normal normal-case">
              ({unresolvedCount} of {actionableIssueCount} unresolved)
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
                    {#if severity === 'note'}
                      {severityIssues.length}
                    {:else}
                      {severityIssues.filter((i) => !i.resolved).length}/{severityIssues.length} open
                    {/if}
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
                      showSubmissionStatus={allowGithubSubmission}
                      submission={allowGithubSubmission && issue.submittedInPrReviewId != null
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
        {:else if review.status === 'complete'}
          <p class="text-xs text-muted-foreground @sm:text-sm">No issues found.</p>
        {/if}

        {#if allowGithubSubmission && review.pr_url && matchedReviewThreads.length > 0}
          <details open class="group pt-3">
            <summary
              class="flex cursor-pointer list-none items-center gap-2 rounded px-1 py-1 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <span
                class="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 @sm:text-sm dark:bg-indigo-900/30 dark:text-indigo-300"
              >
                PR Threads
              </span>
              <span class="text-xs text-muted-foreground @sm:text-sm">
                {unresolvedReviewThreadCount}/{matchedReviewThreads.length} open
              </span>
            </summary>
            <ul class="mt-1 space-y-1.5 pl-1">
              {#each matchedReviewThreads as thread (thread.thread.id)}
                {@const isResolved = !!thread.thread.is_resolved}
                {@const isOutdated = !!thread.thread.is_outdated}
                <li
                  class="rounded-md border border-border bg-card px-2.5 py-2 text-xs @sm:text-sm {isResolved
                    ? 'opacity-60'
                    : ''}"
                >
                  <div class="flex min-w-0 flex-wrap items-center gap-1">
                    <a
                      href={reviewThreadGithubLink(thread)}
                      target="_blank"
                      rel="noreferrer"
                      class="font-mono text-[10px] [overflow-wrap:anywhere] text-blue-600 hover:underline @sm:text-xs dark:text-blue-400"
                    >
                      {reviewThreadLocationLabel(thread)}
                    </a>
                    {#if isResolved}
                      <span
                        class="inline-flex items-center rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-medium text-emerald-800 @sm:text-xs dark:bg-emerald-900/30 dark:text-emerald-300"
                      >
                        Resolved
                      </span>
                    {/if}
                    {#if isOutdated}
                      <span
                        class="inline-flex items-center rounded bg-gray-100 px-1 py-0.5 text-[10px] font-medium text-gray-600 @sm:text-xs dark:bg-gray-800 dark:text-gray-400"
                      >
                        Outdated
                      </span>
                    {/if}
                    <span class="ml-auto text-[10px] text-muted-foreground @sm:text-xs">
                      {thread.comments.length} comment{thread.comments.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <p class="mt-1 line-clamp-3 text-foreground/80">
                    {reviewThreadSummary(thread)}
                  </p>
                  <div class="mt-2 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onclick={() => handleJumpToReviewThreadDiff({ id: thread.thread.id })}
                      class="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground @sm:text-xs dark:hover:bg-gray-800"
                      title="Jump to this review thread in the diff"
                    >
                      <ExternalLink class="size-3 @sm:size-3.5" />
                      Jump to diff
                    </button>
                  </div>
                </li>
              {/each}
            </ul>
          </details>
        {/if}
      </div>
    </Pane>
  </Splitpanes>

  {#if allowGithubSubmission && submitDialogOpen}
    <SubmitReviewDialog
      open={true}
      reviewId={review.id}
      reviewedSha={review.reviewed_sha}
      {currentHeadSha}
      {submitAsCommentOnly}
      {issues}
      onClose={closeSubmitDialog}
      onSubmitted={handleSubmitted}
    />
  {/if}

  {#if newIssueModalState}
    <NewReviewIssueModal
      open={true}
      reviewId={review.id}
      file={newIssueModalState.file}
      startLine={newIssueModalState.startLine}
      endLine={newIssueModalState.endLine}
      side={newIssueModalState.side}
      onSaved={handleNewIssueSaved}
      onClose={closeNewIssueModal}
    />
  {/if}
</div>
