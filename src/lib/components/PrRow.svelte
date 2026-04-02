<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
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
    href,
    itemId,
    projectName,
    selected = false,
    showAuthor = false,
  }: {
    pr: EnrichedProjectPr;
    href: string;
    itemId: string;
    projectName?: string;
    selected?: boolean;
    showAuthor?: boolean;
  } = $props();
</script>

<div
  data-list-item-id={itemId}
  class="flex w-full items-stretch rounded-md transition-colors
    {selected
    ? 'bg-blue-50 ring-1 ring-blue-200 dark:bg-blue-900/30 dark:ring-blue-700'
    : 'hover:bg-gray-50 dark:hover:bg-gray-800'}"
>
  <a {href} data-sveltekit-preload-data class="block min-w-0 flex-1 px-3 py-2 text-left">
    <div class="flex items-center gap-2">
      <span class="shrink-0 text-xs font-medium text-muted-foreground">
        #{pr.status.pr_number}
      </span>
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
    <div class="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground/70">
      {#if projectName}
        <span class="truncate">{projectName}</span>
        <span class="text-muted-foreground/40">&middot;</span>
      {/if}
      {#if showAuthor && pr.status.author}
        <span>{pr.status.author}</span>
        <span class="text-muted-foreground/40">&middot;</span>
      {/if}
      <span class="truncate font-mono">{pr.status.head_branch}</span>
    </div>
  </a>

  <a
    href={pr.status.pr_url}
    target="_blank"
    rel="noopener noreferrer"
    class="flex shrink-0 items-center justify-center border-l border-border px-3 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
    aria-label={`Open pull request #${pr.status.pr_number} on GitHub in new window`}
    title="Open on GitHub in new window"
  >
    <ExternalLink class="size-4" />
  </a>
</div>
