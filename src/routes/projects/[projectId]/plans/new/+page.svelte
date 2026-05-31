<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import PlanMetadataForm from '$lib/components/PlanMetadataForm.svelte';
  import type { PlanMetadataFormValue } from '$lib/components/PlanMetadataForm.svelte';
  import { extractPlanMetadataErrorMessage } from '$lib/components/plan_metadata_form_utils.js';
  import { createPlan } from '$lib/remote/plan_metadata.remote.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let submitting = $state(false);
  let errorMessage: string | null = $state(null);

  async function handleSubmit(value: PlanMetadataFormValue) {
    submitting = true;
    errorMessage = null;
    try {
      const result = await createPlan({
        projectId: data.numericProjectId,
        title: value.title,
        goal: value.goal || null,
        details: value.details || null,
        priority: value.priority,
        status: value.status,
        simple: value.simple,
        tags: value.tags.length > 0 ? value.tags : undefined,
        parentUuid: value.parentUuid,
        basePlanUuid: value.basePlanUuid,
        dependencyUuids: value.dependencyUuids.length > 0 ? value.dependencyUuids : undefined,
      });
      await invalidateAll();
      await goto(`/projects/${result.projectId ?? page.params.projectId}/plans/${result.planUuid}`);
    } catch (err) {
      errorMessage = extractPlanMetadataErrorMessage(err);
    } finally {
      submitting = false;
    }
  }
</script>

<div class="min-w-full p-6 md:min-w-lg">
  <div class="mb-6">
    <h1 class="text-xl font-semibold text-foreground">New Plan</h1>
    <p class="mt-1 text-sm text-muted-foreground">Create a new plan for this project.</p>
  </div>

  <PlanMetadataForm
    projectId={data.numericProjectId}
    mode="create"
    submitLabel="Create"
    {submitting}
    error={errorMessage}
    onsubmit={handleSubmit}
  />
</div>
