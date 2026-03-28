<script lang="ts">
  import { page } from '$app/state';
  import PrDetail from '$lib/components/PrDetail.svelte';
  import { getProjectPrs } from '$lib/remote/project_prs.remote.js';

  let projectId = $derived(page.params.projectId);
  let prNumber = $derived(Number(page.params.prNumber));

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
