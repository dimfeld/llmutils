<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import { searchPlanPicker } from '$lib/remote/plan_picker.remote.js';
  import type { PlanPickerOption, PlanPickerRelation } from '$lib/server/plan_picker_queries.js';

  let {
    projectId,
    relation,
    currentPlanUuid = null,
    selected = $bindable<PlanPickerOption[]>([]),
    label,
    id,
  }: {
    projectId: number;
    relation: PlanPickerRelation;
    currentPlanUuid?: string | null;
    selected: PlanPickerOption[];
    label: string;
    id?: string;
  } = $props();

  let searchQuery = $state('');
  let debouncedQuery = $state('');
  let showDropdown = $state(false);
  let inputElement = $state<HTMLInputElement | null>(null);

  let selectedUuids = $derived(new Set(selected.map((s) => s.uuid)));

  $effect(() => {
    const q = searchQuery;
    if (!q.trim()) {
      debouncedQuery = '';
      return;
    }
    const timer = setTimeout(() => {
      debouncedQuery = q.trim();
    }, 200);
    return () => clearTimeout(timer);
  });

  let searchQueryResource = $derived(
    showDropdown && debouncedQuery
      ? searchPlanPicker({
          projectId,
          query: debouncedQuery,
          relation,
          currentPlanUuid,
          limit: 10,
        })
      : null
  );
  let searchResults = $derived(searchQueryResource?.current ?? null);
  let searchError = $derived(searchQueryResource?.error ?? null);

  let filteredResults = $derived(searchResults?.filter((r) => !selectedUuids.has(r.uuid)) ?? null);

  let isDebouncing = $derived(
    searchQuery.trim().length > 0 && debouncedQuery !== searchQuery.trim()
  );
  let hasQuery = $derived(searchQuery.trim().length > 0);
  let showSearching = $derived(isDebouncing || (searchQueryResource?.loading ?? false));

  function addOption(option: PlanPickerOption) {
    if (!selectedUuids.has(option.uuid)) {
      selected = [...selected, option];
    }
    searchQuery = '';
  }

  function removeOption(uuid: string) {
    selected = selected.filter((s) => s.uuid !== uuid);
  }

  function handleFocus() {
    showDropdown = true;
  }

  function handleBlur(event: FocusEvent) {
    const related = event.relatedTarget as HTMLElement | null;
    if (related?.closest('[data-plan-picker-dropdown]')) {
      return;
    }
    showDropdown = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      showDropdown = false;
      inputElement?.blur();
    }
  }

  function formatOption(option: PlanPickerOption): string {
    if (option.planId == null) {
      return `Unresolved plan: ${option.title ?? option.uuid}`;
    }

    return `#${option.planId}: ${option.title ?? 'Untitled'}`;
  }

  function formatRemoveLabel(option: PlanPickerOption): string {
    if (option.planId == null) {
      return formatOption(option);
    }

    return `#${option.planId}`;
  }
</script>

<div class="space-y-1.5">
  <label for={id} class="text-sm font-medium text-foreground">{label}</label>

  {#if selected.length > 0}
    <div class="flex flex-wrap gap-1.5">
      {#each selected as item (item.uuid)}
        <span
          class="inline-flex items-center gap-1 rounded-md border border-border bg-accent/50 px-2 py-0.5 text-xs"
        >
          {formatOption(item)}
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground"
            aria-label="Remove dependency {formatRemoveLabel(item)}"
            onclick={() => removeOption(item.uuid)}
          >
            <X class="h-3 w-3" />
          </button>
        </span>
      {/each}
    </div>
  {/if}

  <div class="relative">
    <input
      bind:this={inputElement}
      {id}
      type="text"
      placeholder="Search by plan number or title..."
      class="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
      bind:value={searchQuery}
      onfocus={handleFocus}
      onblur={handleBlur}
      onkeydown={handleKeydown}
    />

    {#if showDropdown && hasQuery}
      <div
        data-plan-picker-dropdown
        class="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-background shadow-lg"
      >
        {#if showSearching}
          <div class="px-3 py-2 text-sm text-muted-foreground">Searching...</div>
        {:else if searchError}
          <div class="px-3 py-2 text-sm text-red-600">Failed to search plans</div>
        {:else if filteredResults && filteredResults.length > 0}
          {#each filteredResults as option (option.uuid)}
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
              onmousedown={(e) => {
                e.preventDefault();
                addOption(option);
              }}
            >
              <span class="flex-1 truncate">{formatOption(option)}</span>
              {#if option.status}
                <span class="text-xs text-muted-foreground">{option.status}</span>
              {/if}
            </button>
          {/each}
        {:else if filteredResults}
          <div class="px-3 py-2 text-sm text-muted-foreground">No matching plans</div>
        {/if}
      </div>
    {/if}
  </div>
</div>
