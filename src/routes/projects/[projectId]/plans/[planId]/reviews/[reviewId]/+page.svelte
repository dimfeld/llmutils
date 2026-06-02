<script lang="ts">
  import ReviewGuideView from '$lib/components/ReviewGuideView.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let backHref = $derived(`/projects/${data.projectId}/plans/${data.plan.uuid}`);
  let backLabel = $derived(`Back to plan${data.plan.planId ? ` #${data.plan.planId}` : ''}`);
</script>

<ReviewGuideView
  review={data.review}
  issues={data.issues}
  projectId={data.projectId}
  {backHref}
  {backLabel}
  allowGithubSubmission={data.submissionPrUrl != null}
  submissions={data.submissions}
  linkedPlanUuid={data.linkedPlanUuid ?? data.plan.uuid}
  linkedPlans={data.linkedPlans.length > 0
    ? data.linkedPlans
    : [
        {
          planUuid: data.plan.uuid,
          planId: data.plan.planId,
          title: data.plan.title,
          branch: data.plan.branch,
        },
      ]}
  currentBranch={data.currentBranch}
  currentHeadSha={data.currentHeadSha}
  submitAsCommentOnly={data.submitAsCommentOnly}
  reviewThreads={data.reviewThreads}
/>
