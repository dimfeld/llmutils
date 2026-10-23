<script lang="ts">
  import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
  import type { PlanPrReadiness } from '$lib/server/db_queries.js';

  let { readiness }: { readiness: Exclude<PlanPrReadiness, 'none'> } = $props();

  const labelMap: Record<Exclude<PlanPrReadiness, 'none'>, string> = {
    draft: 'PR draft',
    ready: 'PR ready',
    merged: 'PR merged',
  };

  const titleMap: Record<Exclude<PlanPrReadiness, 'none'>, string> = {
    draft: 'At least one linked PR is still a draft',
    ready: 'All open linked PRs are ready for review',
    merged: 'All linked PRs are merged',
  };

  const colorMap: Record<Exclude<PlanPrReadiness, 'none'>, string> = {
    draft: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    ready: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    merged: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  };
</script>

<span
  class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium {colorMap[
    readiness
  ]}"
  title={titleMap[readiness]}
>
  <GitPullRequest class="size-3" aria-hidden="true" />
  {labelMap[readiness]}
</span>
