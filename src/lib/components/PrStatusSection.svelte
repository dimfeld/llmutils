<script lang="ts">
  import {
    fullRefreshPrStatus,
    getPrStatus,
    refreshPrStatus,
  } from '$lib/remote/pr_status.remote.js';
  import {
    stateBadgeColor,
    stateLabel,
    checksBadgeColor,
    checksLabel,
    labelStyle,
  } from '$lib/utils/pr_display.js';
  import PrCheckRunList from './PrCheckRunList.svelte';
  import PrReviewList from './PrReviewList.svelte';

  let { planUuid }: { planUuid: string } = $props();

  let prData = $derived(await getPrStatus({ planUuid }));
  let prUrls = $derived(prData.prUrls);
  let invalidPrUrls = $derived(prData.invalidPrUrls);
  let tokenConfigured = $derived(prData.tokenConfigured);
  let statusByUrl = $derived(new Map(prData.prStatuses.map((pr) => [pr.status.pr_url, pr])));
  let effectivePrs = $derived(prData.prStatuses);
  let uncachedUrls = $derived(prUrls.filter((url) => !statusByUrl.has(url)));

  let refreshError = $state<string | null>(null);
  let refreshing = $state(false);

  async function handleRefresh() {
    await runRefresh(refreshPrStatus);
  }

  async function handleFullRefresh() {
    await runRefresh(fullRefreshPrStatus);
  }

  async function runRefresh(refreshAction: typeof refreshPrStatus | typeof fullRefreshPrStatus) {
    refreshing = true;
    refreshError = null;
    try {
      const result = await refreshAction({ planUuid });
      if (result.error) {
        refreshError = result.error;
      }
    } catch (err) {
      refreshError = `Failed to refresh: ${err}`;
    } finally {
      refreshing = false;
    }
  }
</script>

<div>
  <div class="mb-2 flex items-center justify-between">
    <h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      Pull Requests
    </h3>
    <div class="flex items-center gap-1.5">
      {#if tokenConfigured}
        <button
          onclick={handleFullRefresh}
          disabled={refreshing}
          class="rounded px-2 py-0.5 text-[11px] text-muted-foreground/80 hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
          aria-label={refreshing
            ? 'Refreshing PR status from GitHub'
            : 'Fully refresh PR status from GitHub'}
        >
          Full Refresh
        </button>
      {/if}
      <button
        onclick={handleRefresh}
        disabled={refreshing}
        class="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
        aria-label={refreshing ? 'Refreshing PR status' : 'Refresh PR status'}
      >
        {refreshing ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
  </div>

  {#if refreshError}
    <p class="mb-2 text-xs text-amber-600 dark:text-amber-400">{refreshError}</p>
  {/if}

  <div class="space-y-4">
    {#if invalidPrUrls.length > 0}
      <div
        class="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
      >
        <div class="font-medium">Invalid pull request entries</div>
        <ul class="mt-1 space-y-1 text-xs">
          {#each invalidPrUrls as invalidUrl (invalidUrl)}
            <li class="break-all">{invalidUrl}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#each effectivePrs as pr (pr.status.pr_url)}
      <div class="rounded-md border border-gray-200 p-3 dark:border-gray-700">
        <!-- PR Header -->
        <div class="flex items-start gap-2">
          <a
            href={pr.status.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            class="min-w-0 flex-1 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            #{pr.status.pr_number}
            {#if pr.status.title}
              {pr.status.title}
            {/if}
          </a>
        </div>

        <!-- Badges -->
        <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
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
          {#if pr.status.review_decision}
            <span
              class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium
                {pr.status.review_decision === 'APPROVED'
                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                : pr.status.review_decision === 'CHANGES_REQUESTED'
                  ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                  : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'}"
            >
              {pr.status.review_decision === 'APPROVED'
                ? 'Approved'
                : pr.status.review_decision === 'CHANGES_REQUESTED'
                  ? 'Changes Requested'
                  : pr.status.review_decision === 'REVIEW_REQUIRED'
                    ? 'Review Required'
                    : pr.status.review_decision}
            </span>
          {/if}
          {#if pr.status.mergeable === 'CONFLICTING'}
            <span
              class="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-300"
            >
              Conflicts
            </span>
          {/if}
        </div>

        <!-- Labels -->
        {#if pr.labels.length > 0}
          <div class="mt-1.5 flex flex-wrap gap-1">
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

        <!-- Expandable Check Runs -->
        {#if pr.checks.length > 0}
          <details class="mt-2">
            <summary
              class="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {pr.checks.length} check{pr.checks.length === 1 ? '' : 's'}
            </summary>
            <div class="mt-1.5 pl-2">
              <PrCheckRunList checks={pr.checks} />
            </div>
          </details>
        {/if}

        <!-- Expandable Reviews -->
        {#if pr.reviews.length > 0}
          <details class="mt-2">
            <summary
              class="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {pr.reviews.length} review{pr.reviews.length === 1 ? '' : 's'}
            </summary>
            <div class="mt-1.5 pl-2">
              <PrReviewList reviews={pr.reviews} />
            </div>
          </details>
        {/if}
      </div>
    {/each}

    {#each uncachedUrls as url (url)}
      <div class="rounded-md border border-gray-200 p-3 dark:border-gray-700">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          class="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          {url}
        </a>
      </div>
    {/each}
  </div>
</div>
