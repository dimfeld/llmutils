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
  allowGithubSubmission={false}
  linkedPlanUuid={data.plan.uuid}
  linkedPlans={[
    {
      planUuid: data.plan.uuid,
      planId: data.plan.planId,
      title: data.plan.title,
      branch: data.plan.branch,
    },
  ]}
/>
