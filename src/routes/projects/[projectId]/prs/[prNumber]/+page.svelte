<script lang="ts">
  import PrDetail from '$lib/components/PrDetail.svelte';
  import { getProjectPrs } from '$lib/remote/project_prs.remote.js';

  const { params } = $props();

  let projectId = $derived(params.projectId);
  let prNumber = $derived(Number(params.prNumber));

  let prData = $derived(await getProjectPrs({ projectId }));

  let pr = $derived.by(() => {
    const allPrs = [...prData.authored, ...prData.reviewing];
    return allPrs.find((p) => p.status.pr_number === prNumber) ?? null;
  });
</script>

{#if pr}
  <PrDetail {pr} {projectId} />
{:else}
  <div class="flex items-center justify-center p-8 text-sm text-muted-foreground">
    Pull request #{prNumber} not found
  </div>
{/if}
