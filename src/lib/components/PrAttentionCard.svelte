<script lang="ts">
  import type { PrAttentionItem } from '$lib/utils/dashboard_attention.js';

  let {
    item,
    projectName,
  }: {
    item: PrAttentionItem;
    projectName?: string;
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
      classes: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
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
</script>

<a
  href={pr.prUrl}
  target="_blank"
  rel="noopener noreferrer"
  class="block w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
>
  <div class="flex items-center gap-2">
    <span class="shrink-0 text-xs font-medium text-muted-foreground">
      {pr.owner}/{pr.repo}#{pr.prNumber}
    </span>
    <span class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
      {pr.title ?? 'Untitled PR'}
    </span>
    <span
      class="inline-block h-2 w-2 shrink-0 rounded-full {checkDotColor}"
      title="Checks: {pr.checkStatus}"
    ></span>
  </div>
  {#if projectName || pr.linkedPlanTitle}
    <div class="mt-0.5 truncate text-xs text-muted-foreground">
      {#if projectName}{projectName}{/if}
      {#if projectName && pr.linkedPlanTitle}
        &middot;
      {/if}
      {#if pr.linkedPlanTitle}Plan #{pr.linkedPlanId}: {pr.linkedPlanTitle}{/if}
    </div>
  {/if}
  <div class="mt-1 flex items-center gap-1.5">
    {#if reasonStyle}
      <span
        class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {reasonStyle.classes}"
      >
        {reasonStyle.label}
      </span>
    {/if}
    {#if pr.author}
      <span class="text-xs text-muted-foreground">by {pr.author}</span>
    {/if}
  </div>
</a>
