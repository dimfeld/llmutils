<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import MessageSquareWarning from '@lucide/svelte/icons/message-square-warning';
  import type { PrAttentionItem } from '$lib/utils/dashboard_attention.js';
  import { buildLinearReviewDeepLink } from '$lib/utils/linear_review_deep_link.js';
  import { formatCompactRelativeTime } from '$lib/utils/time.js';

  let {
    item,
    projectName,
    selected = false,
  }: {
    item: PrAttentionItem;
    projectName?: string;
    selected?: boolean;
  } = $props();

  let pr = $derived(item.actionablePr);

  const reasonStyles: Record<string, { label: string; classes: string }> = {
    ready_to_merge: {
      label: 'Ready to merge',
      classes: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    },
    checks_failing: {
      label: 'Checks failing',
      classes: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    },
    changes_requested: {
      label: 'Changes requested',
      classes: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
    },
    review_requested: {
      label: 'Review requested',
      classes: 'bg-yellow-200 text-yellow-900 dark:bg-yellow-950/60 dark:text-yellow-200',
    },
    approved: {
      label: 'Approved',
      classes: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    },
    open: {
      label: 'Open',
      classes: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    },
  };

  let reasonStyle = $derived(reasonStyles[pr.actionReason]);

  const checkStatusColors: Record<string, string> = {
    passing: 'bg-green-500',
    failing: 'bg-red-500',
    pending: 'bg-yellow-500',
    none: 'bg-gray-400',
  };

  let checkDotColor = $derived(checkStatusColors[pr.checkStatus] ?? 'bg-gray-400');
  let prHref = $derived(`/projects/${pr.projectId}/active/pr/${pr.prNumber}`);
  let externalPrUrl = $derived(
    buildLinearReviewDeepLink({ prUrl: pr.prUrl, prNumber: pr.prNumber }) ?? pr.prUrl
  );
  let reviewRequestedAge = $derived(
    pr.reviewRequestedAt ? formatCompactRelativeTime(pr.reviewRequestedAt) : ''
  );
</script>

<div
  class="flex w-full items-start gap-2 rounded-md px-3 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 {selected
    ? 'bg-gray-100 dark:bg-gray-800'
    : ''}"
>
  <a href={prHref} class="min-w-0 flex-1">
    <div class="truncate text-sm font-medium text-foreground">
      {pr.title ?? 'Untitled PR'}
    </div>
    <div class="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
      <span class="shrink-0 text-xs font-medium text-muted-foreground">
        {pr.owner}/{pr.repo}#{pr.prNumber}
      </span>
      {#if pr.author}
        <span class="shrink-0">by {pr.author}</span>
      {/if}
      {#if projectName || pr.linkedPlanTitle}
        <span class="min-w-0 truncate">
          <span aria-hidden="true">&middot;</span>
          {' '}
          {#if projectName}{projectName}{/if}
          {#if projectName && pr.linkedPlanTitle}
            &middot;
          {/if}
          {#if pr.linkedPlanTitle}Plan #{pr.linkedPlanId}: {pr.linkedPlanTitle}{/if}
        </span>
      {/if}
    </div>
    <div class="mt-1 flex items-center gap-1.5">
      {#if pr.actionReason === 'review_requested' && pr.hasApprovingReview}
        <CircleCheck
          class="size-3.5 shrink-0 text-green-600 dark:text-green-400"
          aria-label="Approved by a reviewer"
        />
      {/if}
      {#if reasonStyle}
        <span
          class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {reasonStyle.classes}"
        >
          {reasonStyle.label}
          {#if pr.actionReason === 'review_requested' && (reviewRequestedAge || pr.reviewRequestedStacked)}
            <span
              class="ml-1 border-l border-yellow-300 pl-1 text-yellow-700 dark:border-yellow-700 dark:text-yellow-200"
            >
              {#if reviewRequestedAge}{reviewRequestedAge}{/if}{#if pr.reviewRequestedStacked}{reviewRequestedAge
                  ? ' '
                  : ''}Stacked{/if}
            </span>
          {:else if pr.actionReason === 'approved' && pr.reviewRequestedStacked}
            <span
              class="ml-1 border-l border-green-300 pl-1 text-green-700 dark:border-green-700 dark:text-green-300"
            >
              Stacked
            </span>
          {/if}
        </span>
      {/if}
      {#if pr.unresolvedReviewThreadCount > 0}
        <span
          class="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs leading-none font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
          title="{pr.unresolvedReviewThreadCount} unresolved review comment{pr.unresolvedReviewThreadCount ===
          1
            ? ''
            : 's'}"
        >
          <MessageSquareWarning class="size-3" />
          {pr.unresolvedReviewThreadCount}
        </span>
      {/if}
      {#if pr.additions != null && pr.deletions != null}
        <span class="text-xs">
          <span class="text-green-600 dark:text-green-400">+{pr.additions}</span>
          <span class="text-muted-foreground">/</span>
          <span class="text-red-600 dark:text-red-400">-{pr.deletions}</span>
        </span>
      {/if}
      <span
        class="inline-block h-2 w-2 shrink-0 rounded-full {checkDotColor}"
        title="Checks: {pr.checkStatus}"
      ></span>
    </div>
  </a>
  <a
    href={externalPrUrl}
    target="_blank"
    rel="noopener noreferrer"
    class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-gray-200 hover:text-foreground dark:hover:bg-gray-700"
    title="Open in Linear Review"
    onclick={(e) => e.stopPropagation()}
  >
    <ExternalLink class="size-3.5" />
  </a>
</div>
