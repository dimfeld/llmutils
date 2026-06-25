<script lang="ts">
  import PrDetail from '$lib/components/PrDetail.svelte';
  import { getProjectPrs } from '$lib/remote/project_prs.remote.js';

  const { params } = $props();

  let projectId = $derived(params.projectId);
  let prNumber = $derived(Number(params.prNumber));
  let prData = $derived(await getProjectPrs({ projectId }));

  let allPrs = $derived(prData ? [...prData.authored, ...prData.reviewing] : []);
  let pr = $derived(allPrs.find((p) => p.status.pr_number === prNumber) ?? null);
</script>

{#if pr}
  <PrDetail {pr} {projectId} {allPrs} username={prData.username} tokenConfigured={prData.tokenConfigured} />
{:else}
  <div class="flex items-center justify-center p-8 text-sm text-muted-foreground">
    Pull request #{prNumber} not found
  </div>
{/if}
