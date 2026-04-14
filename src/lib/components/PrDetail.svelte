<script lang="ts">
  import type { EnrichedProjectPr } from '$lib/remote/project_prs.remote.js';
  import {
    stateBadgeColor,
    stateLabel,
    checksBadgeColor,
    checksLabel,
    labelStyle,
    reviewDecisionBadgeColor,
    reviewDecisionLabel,
  } from '$lib/utils/pr_display.js';
  import PrCheckRunList from './PrCheckRunList.svelte';
  import PrReviewList from './PrReviewList.svelte';
  import PrReviewThreadList from './PrReviewThreadList.svelte';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Copy from '@lucide/svelte/icons/copy';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { normalizeGitHubUsername } from '$common/github/username.js';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import { refreshSinglePrStatus, togglePrDraftStatus } from '$lib/remote/pr_status.remote.js';
  import { startPrReviewGuide } from '$lib/remote/review_thread_actions.remote.js';
  import { getPrReviews } from '$lib/remote/pr_reviews.remote.js';
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';

  let {
    pr,
    projectId,
    username = null,
    tokenConfigured = false,
  }: {
    pr: EnrichedProjectPr;
    projectId: string;
    username?: string | null;
    tokenConfigured?: boolean;
  } = $props();

  let refreshing = $state(false);
  let draftUpdating = $state(false);
  let reviewGuideRunning = $state(false);
  let actionError = $state<string | null>(null);
  let branchCopied = $state(false);
  let graphitePrUrl = $derived(
    `https://app.graphite.com/github/pr/${pr.status.owner}/${pr.status.repo}/${pr.status.pr_number}`
  );
  let reviews = $derived(await getPrReviews({ prUrl: pr.status.pr_url }));
  let latestCompletedReview = $derived(reviews?.find((r) => r.status === 'complete') ?? null);
  let hasNewCommitsSinceReview = $derived(
    pr.status.head_sha != null &&
      latestCompletedReview != null &&
      latestCompletedReview.reviewed_sha != null &&
      pr.status.head_sha !== latestCompletedReview.reviewed_sha
  );
  let sortedLinkedPlans = $derived([...pr.linkedPlans].sort((a, b) => a.planId - b.planId));

  // Get planUuid if there's exactly one linked plan, otherwise undefined
  let planUuid = $derived(pr.linkedPlans.length === 1 ? pr.linkedPlans[0].planUuid : undefined);
  let isOwnPr = $derived.by(() => {
    if (!username || !pr.status.author) {
      return false;
    }

    return normalizeGitHubUsername(pr.status.author) === normalizeGitHubUsername(username);
  });
  let canToggleDraft = $derived(tokenConfigured && pr.status.state === 'open' && isOwnPr);
  let draftButtonLabel = $derived(pr.status.draft ? 'Mark ready for review' : 'Convert to draft');

  async function handleRefresh() {
    actionError = null;
    refreshing = true;
    try {
      await refreshSinglePrStatus({ prUrl: pr.status.pr_url });
      // Trigger a revalidation by reloading the page data
      location.reload();
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      refreshing = false;
    }
  }

  async function handleToggleDraftStatus() {
    if (!canToggleDraft || draftUpdating) {
      return;
    }

    actionError = null;
    draftUpdating = true;
    try {
      await togglePrDraftStatus({
        owner: pr.status.owner,
        repo: pr.status.repo,
        prNumber: pr.status.pr_number,
        prUrl: pr.status.pr_url,
        draft: !pr.status.draft,
      });
      location.reload();
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      draftUpdating = false;
    }
  }

  async function handleStartReviewGuide() {
    if (reviewGuideRunning) {
      return;
    }

    actionError = null;
    reviewGuideRunning = true;
    try {
      await startPrReviewGuide({
        projectId: pr.projectId,
        prNumber: pr.status.pr_number,
      });
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      reviewGuideRunning = false;
    }
  }

  async function handleCopyHeadBranch() {
    if (!pr.status.head_branch) {
      return;
    }

    try {
      await navigator.clipboard.writeText(pr.status.head_branch);
      branchCopied = true;
      setTimeout(() => {
        branchCopied = false;
      }, 1500);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<div
  class="overflow-x-hidden overflow-y-auto px-6 py-6 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
  role="region"
  aria-label="Pull request details"
  tabindex="0"
>
  <div class="space-y-4 pb-4">
    <!-- Header -->
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <h2 class="text-lg font-semibold text-foreground">
          <span class="text-muted-foreground">#{pr.status.pr_number}</span>
          {pr.status.title ?? 'Untitled'}
          <a
            href={pr.status.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            class="ml-1 inline-flex rounded-md p-1 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
            title="Open on GitHub"
          >
            <ExternalLink class="size-4" />
          </a>
        </h2>
        <div class="mt-1 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <span>{pr.status.head_branch}</span>
          <button
            type="button"
            onclick={handleCopyHeadBranch}
            class="rounded p-0.5 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
            aria-label="Copy head branch"
            title="Copy head branch"
          >
            <Copy class="size-3" />
          </button>
          <span class="text-foreground/60"
            >{pr.status.base_branch ? `→ ${pr.status.base_branch}` : ''}</span
          >
          {#if branchCopied}
            <span class="text-emerald-600">Copied</span>
          {/if}
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <a
          href={graphitePrUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
          title="View in Graphite"
          aria-label={`View PR #${pr.status.pr_number} in Graphite`}
        >
          View in Graphite
        </a>
        {#if canToggleDraft}
          <button
            onclick={handleToggleDraftStatus}
            disabled={draftUpdating}
            class="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800"
            title={draftButtonLabel}
          >
            {draftUpdating ? 'Updating...' : draftButtonLabel}
          </button>
        {/if}
        <button
          onclick={handleRefresh}
          disabled={refreshing}
          class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800"
          title="Refresh PR data"
        >
          <RefreshCw class="size-4 {refreshing ? 'animate-spin' : ''}" />
        </button>
      </div>
    </div>

    {#if actionError}
      <div
        class="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300"
      >
        {actionError}
      </div>
    {/if}

    <!-- Badges -->
    <div class="flex flex-wrap items-center gap-1.5">
      <span
        class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {stateBadgeColor(
          pr.status.state,
          pr.status.draft
        )}"
      >
        {stateLabel(pr.status.state, pr.status.draft)}
      </span>
      <span
        class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {checksBadgeColor(
          pr.status.check_rollup_state
        )}"
      >
        {checksLabel(pr.status.check_rollup_state)}
      </span>
      {#if pr.currentUserReviewRequestLabel}
        <span
          class="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300"
        >
          {pr.currentUserReviewRequestLabel}
        </span>
      {:else if pr.status.review_decision}
        <span
          class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {reviewDecisionBadgeColor(
            pr.status.review_decision
          )}"
        >
          {reviewDecisionLabel(pr.status.review_decision)}
        </span>
      {/if}
      {#if pr.status.mergeable === 'CONFLICTING'}
        <span
          class="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-300"
        >
          Conflicts
        </span>
      {/if}
      {#if pr.currentUserPushedAfterReview}
        <span
          class="inline-flex items-center rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800 dark:bg-orange-900/30 dark:text-orange-300"
        >
          New commits since your review
        </span>
      {/if}
    </div>

    <!-- Labels -->
    {#if pr.labels.length > 0}
      <div class="flex flex-wrap gap-1">
        {#each pr.labels as label (label.name)}
          <span
            class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
            style={labelStyle(label.color)}
          >
            {label.name}
          </span>
        {/each}
      </div>
    {/if}

    <!-- Author -->
    {#if pr.status.author}
      <div class="text-sm text-muted-foreground">
        Opened by <span class="font-medium text-foreground">{pr.status.author}</span>
      </div>
    {/if}

    <!-- Last push -->
    {#if pr.status.latest_commit_pushed_at}
      <div class="text-sm text-muted-foreground">
        Last push: <span class="font-medium text-foreground"
          >{formatRelativeTime(pr.status.latest_commit_pushed_at)}</span
        >
      </div>
    {/if}

    <!-- Diff stats -->
    {#if pr.status.additions != null && pr.status.deletions != null && pr.status.changed_files != null}
      <div class="text-sm text-muted-foreground">
        {pr.status.changed_files} file{pr.status.changed_files === 1 ? '' : 's'} changed,
        <span class="text-green-600 dark:text-green-400">+{pr.status.additions}</span>
        /
        <span class="text-red-600 dark:text-red-400">-{pr.status.deletions}</span>
      </div>
    {/if}

    <!-- Linked Plans -->
    {#if pr.linkedPlans.length > 0}
      <div>
        <h3 class="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Linked Plans
        </h3>
        <ul class="space-y-1">
          {#each sortedLinkedPlans as plan (plan.planUuid)}
            <li>
              <a
                href="/projects/{projectId}/plans/{plan.planUuid}"
                class="text-sm text-blue-600 hover:underline dark:text-blue-400"
              >
                #{plan.planId}
                {#if plan.title}
                  {plan.title}
                {/if}
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- Review Guides -->
    <div>
      <div class="mb-1.5 flex items-center justify-between">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Review Guides
        </h3>
        <button
          onclick={handleStartReviewGuide}
          disabled={reviewGuideRunning}
          class="rounded px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800"
          title="Generate a new review guide"
        >
          {reviewGuideRunning ? 'Starting...' : 'Generate'}
        </button>
      </div>

      {#if hasNewCommitsSinceReview}
        <div
          class="mb-2 flex items-center gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
        >
          <AlertTriangle class="size-3 shrink-0" />
          New commits since last review
        </div>
      {/if}

      {#if reviews && reviews.length > 0}
        <ul class="space-y-1">
          {#each reviews as review (review.id)}
            {@const statusColor =
              review.status === 'complete'
                ? 'text-green-600 dark:text-green-400'
                : review.status === 'error'
                  ? 'text-red-600 dark:text-red-400'
                  : review.status === 'in_progress'
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-muted-foreground'}
            <li>
              <a
                href="/projects/{projectId}/prs/{pr.status.pr_number}/reviews/{review.id}"
                class="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <span class="min-w-0 flex-1 truncate text-foreground">
                  {formatRelativeTime(review.created_at)}
                </span>
                {#if review.status === 'complete'}
                  <span class="shrink-0 text-xs text-muted-foreground">
                    {review.unresolved_count}/{review.issue_count} open
                  </span>
                {/if}
                <span class="shrink-0 text-xs {statusColor}">
                  {review.status === 'complete'
                    ? 'Complete'
                    : review.status === 'error'
                      ? 'Error'
                      : review.status === 'in_progress'
                        ? 'Running'
                        : 'Pending'}
                </span>
              </a>
            </li>
          {/each}
        </ul>
      {:else if reviews}
        <p class="text-xs text-muted-foreground">No review guides generated yet.</p>
      {/if}
    </div>

    <!-- Check Runs -->
    {#if pr.checks.length > 0}
      <details open>
        <summary
          class="cursor-pointer text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
        >
          {pr.checks.length} check{pr.checks.length === 1 ? '' : 's'}
        </summary>
        <div class="mt-1.5 pl-2">
          <PrCheckRunList checks={pr.checks} requiredCheckNames={pr.requiredCheckNames ?? []} />
        </div>
      </details>
    {/if}

    <!-- Reviews -->
    {#if pr.reviews.length > 0}
      <details open>
        <summary
          class="cursor-pointer text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
        >
          {pr.reviews.length} review{pr.reviews.length === 1 ? '' : 's'}
        </summary>
        <div class="mt-1.5 pl-2">
          <PrReviewList reviews={pr.reviews} />
        </div>
      </details>
    {/if}

    <!-- Review Threads -->
    {#if pr.reviewThreads?.length}
      {@const unresolvedCount = pr.reviewThreads.filter((t) => !t.thread.is_resolved).length}
      <details open>
        <summary
          class="cursor-pointer text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
        >
          {pr.reviewThreads.length} review thread{pr.reviewThreads.length === 1 ? '' : 's'}
          {#if unresolvedCount > 0}
            <span class="text-amber-600 dark:text-amber-400">
              ({unresolvedCount} unresolved)
            </span>
          {/if}
        </summary>
        <div class="mt-1.5 pl-2">
          <PrReviewThreadList
            threads={pr.reviewThreads}
            prUrl={pr.status.pr_url}
            {planUuid}
            currentUsername={username}
          />
        </div>
      </details>
    {/if}

    <!-- Last fetched -->
    {#if pr.status.last_fetched_at}
      <div class="text-xs text-muted-foreground/70">
        Last updated: {new Date(pr.status.last_fetched_at).toLocaleString()}
      </div>
    {/if}
  </div>
</div>
