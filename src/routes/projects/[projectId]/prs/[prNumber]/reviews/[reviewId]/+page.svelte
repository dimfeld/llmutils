<script lang="ts">
  import { page } from '$app/state';
  import ReviewGuideView from '$lib/components/ReviewGuideView.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let projectId = $derived(page.params.projectId ?? '');
  let prNumber = $derived(page.params.prNumber ?? '');
</script>

<ReviewGuideView
  review={data.review}
  issues={data.issues}
  submissions={data.submissions}
  linkedPlans={data.linkedPlans}
  linkedPlanUuid={data.linkedPlanUuid}
  currentBranch={data.currentBranch}
  currentHeadSha={data.currentHeadSha}
  submitAsCommentOnly={data.submitAsCommentOnly}
  reviewThreads={data.reviewThreads}
  {projectId}
  backHref="/projects/{projectId}/prs/{prNumber}"
  backLabel="Back to PR #{prNumber}"
  allowGithubSubmission={true}
/>
