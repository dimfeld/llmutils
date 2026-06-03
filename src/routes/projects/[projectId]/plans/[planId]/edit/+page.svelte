<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import PlanMetadataForm from '$lib/components/PlanMetadataForm.svelte';
  import type { PlanMetadataFormValue } from '$lib/components/PlanMetadataForm.svelte';
  import { extractPlanMetadataErrorMessage } from '$lib/components/plan_metadata_form_utils.js';
  import { updatePlanMetadata } from '$lib/remote/plan_metadata.remote.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let submitting = $state(false);
  let errorMessage: string | null = $state(null);

  async function handleSubmit(value: PlanMetadataFormValue) {
    submitting = true;
    errorMessage = null;
    try {
      await updatePlanMetadata({
        projectId: data.actualProjectId,
        planUuid: data.planUuid,
        title: value.title,
        goal: value.goal || null,
        note: value.note || null,
        details: value.details || null,
        priority: value.priority,
        status: value.status,
        simple: value.simple,
        tags: value.tags,
        parentUuid: value.parentUuid,
        basePlanUuid: value.basePlanUuid,
        dependencyUuids: value.dependencyUuids,
      });
      await invalidateAll();
      await goto(data.cancelHref);
    } catch (err) {
      errorMessage = extractPlanMetadataErrorMessage(err);
    } finally {
      submitting = false;
    }
  }
</script>

<div class="min-w-full p-6 md:min-w-lg">
  <div class="mb-6">
    <h1 class="text-xl font-semibold text-foreground">Edit Plan</h1>
    <p class="mt-1 text-sm text-muted-foreground">
      Update metadata for #{data.planId}{data.title ? `: ${data.title}` : ''}.
    </p>
  </div>

  {#key data.planUuid}
    <PlanMetadataForm
      projectId={data.actualProjectId}
      mode="edit"
      initialValue={data.initialValue}
      submitLabel="Save"
      {submitting}
      error={errorMessage}
      currentPlanUuid={data.planUuid}
      cancelHref={data.cancelHref}
      onsubmit={handleSubmit}
    />
  {/key}
</div>
