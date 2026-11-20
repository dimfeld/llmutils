<script lang="ts">
  import { onMount } from 'svelte';
  import PrDetail from '$lib/components/PrDetail.svelte';
  import { getPrReviewThreads, getProjectPrs } from '$lib/remote/project_prs.remote.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { hasRelevantPrUpdate } from '$lib/utils/pr_update_events.js';

  const { params, data } = $props();
  const sessionManager = useSessionManager();

  let projectId = $derived(params.projectId);
  let prNumber = $derived(Number(params.prNumber));

  let prData = $derived(await getProjectPrs({ projectId }));

  let allPrs = $derived([...prData.authored, ...prData.reviewing]);
  let mergedPrs = $derived(
    prData ? [...prData.recentlyMerged.authored, ...prData.recentlyMerged.reviewing] : []
  );
  let listPr = $derived(
    [...allPrs, ...mergedPrs].find((p) => p.status.pr_number === prNumber) ?? null
  );
  let listPrUrl = $derived(listPr?.status.pr_url ?? null);
  // The list query loads review threads without their comments. Load the full threads here.
  let reviewThreads = $derived(listPrUrl ? await getPrReviewThreads({ prUrl: listPrUrl }) : null);
  let pr = $derived(listPr && reviewThreads ? { ...listPr, reviewThreads } : listPr);

  onMount(() => {
    return sessionManager.onEvent((eventName, event) => {
      if (eventName === 'pr:updated' && listPrUrl && hasRelevantPrUpdate(event, [listPrUrl])) {
        getPrReviewThreads({ prUrl: listPrUrl }).refresh();
      }
    });
  });
</script>

{#if pr}
  <PrDetail
    {pr}
    {projectId}
    {allPrs}
    username={prData.username}
    tokenConfigured={prData.tokenConfigured}
    chatExecutorOptions={data.chatExecutorOptions}
    prFixExecutorOptions={data.prFixExecutorOptions}
  />
{:else}
  <div class="flex items-center justify-center p-8 text-sm text-muted-foreground">
    Pull request #{prNumber} not found
  </div>
{/if}
