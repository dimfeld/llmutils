<script lang="ts">
  import type { EnrichedProjectPr } from '$lib/remote/project_prs.remote.js';
  import PrStatusIndicator from './PrStatusIndicator.svelte';
  import {
    checkRollupToSummaryStatus,
    reviewDecisionBadgeColor,
    reviewDecisionLabel,
    stateBadgeColor,
    stateLabel,
  } from '$lib/utils/pr_display.js';

  let {
    pr,
    projectId,
    selected = false,
  }: {
    pr: EnrichedProjectPr;
    projectId: string;
    selected?: boolean;
  } = $props();
</script>

<a
  href="/projects/{projectId}/prs/{pr.status.pr_number}"
  data-list-item-id={String(pr.status.pr_number)}
  data-sveltekit-preload-data
  class="block w-full rounded-md px-3 py-2 text-left transition-colors
    {selected
    ? 'bg-blue-50 ring-1 ring-blue-200 dark:bg-blue-900/30 dark:ring-blue-700'
    : 'hover:bg-gray-50 dark:hover:bg-gray-800'}"
>
  <div class="flex items-center gap-2">
    <span class="shrink-0 text-xs font-medium text-muted-foreground">#{pr.status.pr_number}</span>
    <span class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
      {pr.status.title ?? 'Untitled'}
    </span>
  </div>
  <div class="mt-1 flex items-center gap-1.5">
    <PrStatusIndicator
      status={pr.status.draft ? 'none' : checkRollupToSummaryStatus(pr.status.check_rollup_state)}
    />
    {#if pr.status.draft}
      <span
        class="inline-flex items-center rounded-full px-1.5 py-0.5 text-xs leading-none font-medium {stateBadgeColor(
          pr.status.state,
          pr.status.draft
        )}"
      >
        {stateLabel(pr.status.state, pr.status.draft)}
      </span>
    {:else if pr.status.review_decision}
      <span
        class="inline-flex items-center rounded-full px-1.5 py-0.5 text-xs leading-none font-medium {reviewDecisionBadgeColor(
          pr.status.review_decision
        )}"
      >
        {reviewDecisionLabel(pr.status.review_decision)}
      </span>
    {/if}
    {#if pr.linkedPlans.length > 0}
      <span class="text-xs text-muted-foreground">
        Plan #{pr.linkedPlans[0].planId}{pr.linkedPlans.length > 1
          ? ` +${pr.linkedPlans.length - 1}`
          : ''}
      </span>
    {/if}
  </div>
  <div class="mt-0.5 truncate font-mono text-xs text-muted-foreground/70">
    {pr.status.head_branch}
  </div>
</a>
