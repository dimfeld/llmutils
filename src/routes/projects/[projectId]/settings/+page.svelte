<script lang="ts">
  import { invalidateAll, afterNavigate } from '$app/navigation';
  import { updateProjectSetting } from '$lib/remote/project_settings.remote.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let featured = $derived((data.settings.featured as boolean) ?? true);

  let submitting = $state(false);
  let errorMessage: string | null = $state(null);

  afterNavigate(({ from, to }) => {
    if (from && to && from.url.pathname !== to.url.pathname) {
      submitting = false;
      errorMessage = null;
    }
  });

  async function handleSave() {
    if (!data.currentProject) return;

    submitting = true;
    errorMessage = null;
    try {
      await updateProjectSetting({
        projectId: data.currentProject.id,
        setting: 'featured',
        value: featured,
      });
      await invalidateAll();
    } catch (err) {
      errorMessage = (err as Error).message || 'Failed to save settings';
    } finally {
      submitting = false;
    }
  }
</script>

<div class="p-6">
  <div class="mb-6">
    <h1 class="text-xl font-semibold text-foreground">Project Settings</h1>
    <p class="mt-1 text-sm text-muted-foreground">Configure settings for this project.</p>
  </div>

  <div class="space-y-6">
    <div class="rounded-lg border border-border p-4">
      <div class="flex items-center justify-between">
        <div>
          <Label for="featured-toggle" class="text-sm font-medium text-foreground">Featured</Label>
          <p class="text-sm text-muted-foreground">
            Featured projects appear in the main sidebar list. Non-featured projects are grouped in
            a collapsed section.
          </p>
        </div>
        <Switch id="featured-toggle" bind:checked={featured} />
      </div>
    </div>

    <div class="flex items-center gap-3">
      <Button disabled={submitting} onclick={handleSave}>
        {submitting ? 'Saving...' : 'Save Settings'}
      </Button>
      {#if errorMessage}
        <p class="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
      {/if}
    </div>
  </div>
</div>
