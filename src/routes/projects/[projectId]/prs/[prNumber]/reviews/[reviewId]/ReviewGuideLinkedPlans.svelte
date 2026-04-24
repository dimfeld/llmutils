<script lang="ts">
  import type { LinkedPlanSummary } from '$tim/db/pr_status.js';

  interface Props {
    projectId: string;
    linkedPlans: LinkedPlanSummary[];
  }

  let { projectId, linkedPlans }: Props = $props();

  let sortedLinkedPlans = $derived([...linkedPlans].sort((a, b) => a.planId - b.planId));
</script>

{#if sortedLinkedPlans.length > 0}
  <div class="flex flex-wrap items-center gap-1.5 text-sm">
    <span class="text-muted-foreground">
      Linked plan{sortedLinkedPlans.length === 1 ? '' : 's'}:
    </span>
    {#each sortedLinkedPlans as plan (plan.planUuid)}
      <a
        href="/projects/{projectId}/plans/{plan.planUuid}"
        class="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 py-1 font-medium text-blue-600 transition-colors hover:bg-gray-100 hover:underline dark:text-blue-400 dark:hover:bg-gray-800"
        title={plan.title ?? `Plan #${plan.planId}`}
      >
        <span>#{plan.planId}</span>
        {#if plan.title}
          <span class="max-w-[24rem] truncate text-foreground/80">{plan.title}</span>
        {/if}
      </a>
    {/each}
  </div>
{/if}
