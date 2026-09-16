<script lang="ts">
  import SessionChatButton from '$lib/components/SessionChatButton.svelte';
  import { page } from '$app/state';
  import ReviewGuideView from '$lib/components/ReviewGuideView.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let projectId = $derived(page.params.projectId ?? '');
  let prNumber = $derived(page.params.prNumber ?? '');
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="shrink-0 px-6 pt-3">
    <SessionChatButton target={{ projectId, prNumber: Number(prNumber) }} />
  </div>
  <ReviewGuideView
    review={data.review}
    issues={data.issues}
    submissions={data.submissions}
    linkedPlans={data.linkedPlans}
    linkedPlanUuid={data.linkedPlanUuid}
    currentBranch={data.currentBranch}
    currentHeadSha={data.currentHeadSha}
    submissionPrUrl={data.submissionPrUrl}
    submitAsCommentOnly={data.submitAsCommentOnly}
    reviewThreads={data.reviewThreads}
    {projectId}
    backHref="/projects/{projectId}/prs/{prNumber}"
    backLabel="Back to PR #{prNumber}"
    allowGithubSubmission={true}
  />
</div>
