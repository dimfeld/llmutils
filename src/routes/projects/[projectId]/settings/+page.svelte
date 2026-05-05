<script lang="ts">
  import { invalidateAll, afterNavigate } from '$app/navigation';
  import { updateProjectSettings } from '$lib/remote/project_settings.remote.js';
  import { getProjectSettingsSyncStatus } from '$lib/remote/sync_status.remote.js';
  import { getSettingsBannerState } from '$lib/components/sync_indicator_state.js';
  import {
    getContrastTextColor,
    getProjectAbbreviation,
    getProjectColor,
    projectDisplayName,
    PROJECT_COLOR_PALETTE,
  } from '$lib/stores/project.svelte.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let displayName = $derived(
    projectDisplayName(data.currentProject?.repository_id ?? null, data.currentUsername)
  );
  let autoAbbreviation = $derived(getProjectAbbreviation(displayName));
  let autoColor = $derived(getProjectColor(displayName));

  let serverFeatured = $derived((data.settings.featured as boolean) ?? true);
  let serverAbbreviation = $derived((data.settings.abbreviation as string | undefined) ?? '');
  let serverColor = $derived((data.settings.color as string | undefined) ?? '');
  let serverBranchPrefix = $derived((data.settings.branchPrefix as string | undefined) ?? '');
  let baseRevisions = $derived({
    featured: data.settingMetadata.featured?.revision ?? 0,
    abbreviation: data.settingMetadata.abbreviation?.revision ?? 0,
    color: data.settingMetadata.color?.revision ?? 0,
    branchPrefix: data.settingMetadata.branchPrefix?.revision ?? 0,
  });

  let featured = $derived(serverFeatured);
  let abbreviation = $derived(serverAbbreviation);
  let color = $derived(serverColor);
  let branchPrefix = $derived(serverBranchPrefix);

  let hasChanges = $derived(
    featured !== serverFeatured ||
      abbreviation !== serverAbbreviation ||
      color !== serverColor ||
      branchPrefix !== serverBranchPrefix
  );

  let submitting = $state(false);
  let errorMessage: string | null = $state(null);

  let numericProjectId = $derived(Number(data.projectId));
  let syncStatusQuery = $derived(
    Number.isFinite(numericProjectId)
      ? getProjectSettingsSyncStatus({ projectId: numericProjectId })
      : null
  );
  let syncStatus = $derived(syncStatusQuery?.current ?? null);
  let syncMessage = $derived(getSettingsBannerState(syncStatus));

  afterNavigate(({ from, to }) => {
    if (from && to && from.url.pathname !== to.url.pathname) {
      submitting = false;
      errorMessage = null;
    }
  });

  async function handleSave() {
    if (Number.isNaN(numericProjectId)) return;

    submitting = true;
    errorMessage = null;
    try {
      const updates: Array<{ setting: string; value: unknown; baseRevision: number }> = [];

      if (featured !== serverFeatured) {
        updates.push({
          setting: 'featured',
          value: featured,
          baseRevision: baseRevisions.featured,
        });
      }
      if (abbreviation !== serverAbbreviation) {
        updates.push({
          setting: 'abbreviation',
          value: abbreviation,
          baseRevision: baseRevisions.abbreviation,
        });
      }
      if (color !== serverColor) {
        updates.push({ setting: 'color', value: color, baseRevision: baseRevisions.color });
      }
      if (branchPrefix !== serverBranchPrefix) {
        updates.push({
          setting: 'branchPrefix',
          value: branchPrefix,
          baseRevision: baseRevisions.branchPrefix,
        });
      }

      if (updates.length === 0) return;

      await updateProjectSettings({ projectId: numericProjectId, settings: updates });
      await invalidateAll();
      syncStatusQuery?.refresh();
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

  {#if syncMessage}
    <div
      class={[
        'mb-4 rounded-md border px-3 py-2 text-sm',
        syncMessage.tone === 'error'
          ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200'
          : 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-200',
      ]}
      role="status"
    >
      {syncMessage.text}
    </div>
  {/if}

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

    <div class="rounded-lg border border-border p-4">
      <div class="space-y-3">
        <div>
          <Label for="abbreviation-input" class="text-sm font-medium text-foreground"
            >Sidebar Abbreviation</Label
          >
          <p class="text-sm text-muted-foreground">
            Short label (up to 4 characters) shown in the collapsed sidebar. Defaults to "{autoAbbreviation}".
          </p>
        </div>
        <Input
          id="abbreviation-input"
          maxlength={4}
          placeholder={autoAbbreviation}
          bind:value={abbreviation}
          class="w-32"
        />
      </div>
    </div>

    <div class="rounded-lg border border-border p-4">
      <div class="space-y-3">
        <div>
          <Label class="text-sm font-medium text-foreground">Sidebar Color</Label>
          <p class="text-sm text-muted-foreground">
            Avatar color in the collapsed sidebar. Defaults to the automatically assigned color.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-md border-2 text-xs font-medium {color ===
            ''
              ? 'border-blue-500'
              : 'border-transparent hover:border-gray-400'}"
            style="background-color: {autoColor}; color: {getContrastTextColor(autoColor)};"
            title="Default (auto-assigned)"
            aria-label="Default (auto-assigned)"
            aria-pressed={color === ''}
            onclick={() => (color = '')}
          >
            A
          </button>
          {#each PROJECT_COLOR_PALETTE as paletteColor}
            <button
              type="button"
              class="h-8 w-8 rounded-md border-2 {color === paletteColor
                ? 'border-blue-500'
                : 'border-transparent hover:border-gray-400'}"
              style="background-color: {paletteColor};"
              title={paletteColor}
              aria-label="Color {paletteColor}"
              aria-pressed={color === paletteColor}
              onclick={() => (color = paletteColor)}
            ></button>
          {/each}
        </div>
      </div>
    </div>

    <div class="rounded-lg border border-border p-4">
      <div class="space-y-3">
        <div>
          <Label for="branch-prefix-input" class="text-sm font-medium text-foreground"
            >Branch Prefix</Label
          >
          <p class="text-sm text-muted-foreground">
            Prefix to prepend to auto-generated branch names (e.g. "di/" produces
            "di/123-feature-name"). A separator (/, -, or _) is appended automatically if missing.
          </p>
        </div>
        <Input
          id="branch-prefix-input"
          maxlength={20}
          placeholder="e.g. di/"
          bind:value={branchPrefix}
          class="w-40"
        />
      </div>
    </div>

    <div class="flex items-center gap-3">
      <Button disabled={submitting || !hasChanges} onclick={handleSave}>
        {submitting ? 'Saving...' : 'Save Settings'}
      </Button>
      {#if errorMessage}
        <p class="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
      {/if}
    </div>
  </div>
</div>
