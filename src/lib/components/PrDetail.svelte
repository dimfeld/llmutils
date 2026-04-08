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
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import { refreshSinglePrStatus } from '$lib/remote/pr_status.remote.js';

  let { pr, projectId }: { pr: EnrichedProjectPr; projectId: string } = $props();

  let refreshing = $state(false);
  let refreshError = $state<string | null>(null);

  // Get planUuid if there's exactly one linked plan, otherwise undefined
  let planUuid = $derived(
    pr.linkedPlans.length === 1 ? pr.linkedPlans[0].planUuid : undefined
  );

  async function handleRefresh() {
    refreshError = null;
    refreshing = true;
    try {
      await refreshSinglePrStatus({ prUrl: pr.status.pr_url });
      // Trigger a revalidation by reloading the page data
      location.reload();
    } catch (err) {
      refreshError = err instanceof Error ? err.message : String(err);
    } finally {
      refreshing = false;
    }
  }
</script>

<div class="space-y-4 p-6">
  <!-- Header -->
  <div class="flex items-start gap-2">
    <div class="min-w-0 flex-1">
      <h2 class="text-lg font-semibold text-foreground">
        <span class="text-muted-foreground">#{pr.status.pr_number}</span>
        {pr.status.title ?? 'Untitled'}
      </h2>
      <div class="mt-1 font-mono text-xs text-muted-foreground">
        {pr.status.head_branch} &rarr; {pr.status.base_branch}
      </div>
    </div>
    <div class="flex items-center gap-1 shrink-0">
      <button
        onclick={handleRefresh}
        disabled={refreshing}
        class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed dark:hover:bg-gray-800"
        title="Refresh PR data"
      >
        <RefreshCw class="size-4 {refreshing ? 'animate-spin' : ''}" />
      </button>
      <a
        href={pr.status.pr_url}
        target="_blank"
        rel="noopener noreferrer"
        class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
        title="Open on GitHub"
      >
        <ExternalLink class="size-4" />
      </a>
    </div>
  </div>

  {#if refreshError}
    <div class="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
      {refreshError}
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

  <!-- Linked Plans -->
  {#if pr.linkedPlans.length > 0}
    <div>
      <h3 class="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Linked Plans
      </h3>
      <ul class="space-y-1">
        {#each pr.linkedPlans as plan (plan.planUuid)}
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

  <!-- Check Runs -->
  {#if pr.checks.length > 0}
    <details open>
      <summary
        class="cursor-pointer text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
      >
        {pr.checks.length} check{pr.checks.length === 1 ? '' : 's'}
      </summary>
      <div class="mt-1.5 pl-2">
        <PrCheckRunList checks={pr.checks} />
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
        <PrReviewThreadList threads={pr.reviewThreads} prUrl={pr.status.pr_url} {planUuid} />
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
