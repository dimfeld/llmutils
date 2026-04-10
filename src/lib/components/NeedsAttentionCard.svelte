<script lang="ts">
  import type { PlanAttentionItem } from '$lib/utils/dashboard_attention.js';
  import PlanAttentionActions from './PlanAttentionActions.svelte';

  let {
    item,
    projectId,
    projectName,
    selected = false,
    developmentWorkflow = 'pr-based' as const,
  }: {
    item: PlanAttentionItem;
    projectId: string;
    projectName?: string;
    selected?: boolean;
    developmentWorkflow?: 'pr-based' | 'trunk-based';
  } = $props();

  let planHref = $derived(`/projects/${projectId}/active/plan/${item.planUuid}`);
</script>

<div
  class="flex w-full flex-col gap-2 rounded-md px-3 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 {selected
    ? 'bg-gray-100 dark:bg-gray-800'
    : ''}"
>
  <a href={planHref} class="w-full min-w-0" data-sveltekit-preload-data>
    <div class="flex items-center gap-2">
      <span class="shrink-0 text-xs font-medium text-muted-foreground">#{item.planId}</span>
      {#if item.epic}
        <span
          class="shrink-0 rounded-full bg-indigo-100 px-1.5 py-0.5 text-xs leading-none font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
        >
          Epic
        </span>
      {/if}
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {item.planTitle ?? 'Untitled'}
      </span>
    </div>
    {#if projectName}
      <div class="mt-0.5 truncate text-xs text-muted-foreground">{projectName}</div>
    {/if}
  </a>
  <PlanAttentionActions
    planUuid={item.planUuid}
    {projectId}
    reasons={item.reasons}
    reviewIssueCount={item.reviewIssueCount}
    canUpdateDocs={item.canUpdateDocs}
    hasPr={item.hasPr}
    epic={item.epic}
    {developmentWorkflow}
  />
</div>
