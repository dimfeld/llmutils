<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import { searchPlanPicker } from '$lib/remote/plan_picker.remote.js';
  import type { PlanPickerOption, PlanPickerRelation } from '$lib/server/plan_picker_queries.js';

  let {
    projectId,
    relation,
    currentPlanUuid = null,
    selected = $bindable<PlanPickerOption | null>(null),
    label,
    id,
  }: {
    projectId: number;
    relation: PlanPickerRelation;
    currentPlanUuid?: string | null;
    selected: PlanPickerOption | null;
    label: string;
    id?: string;
  } = $props();

  let searchQuery = $state('');
  let debouncedQuery = $state('');
  let showDropdown = $state(false);
  let inputElement = $state<HTMLInputElement | null>(null);

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

  let isDebouncing = $derived(
    searchQuery.trim().length > 0 && debouncedQuery !== searchQuery.trim()
  );
  let hasQuery = $derived(searchQuery.trim().length > 0);
  let showSearching = $derived(isDebouncing || (searchQueryResource?.loading ?? false));

  function selectOption(option: PlanPickerOption) {
    selected = option;
    searchQuery = '';
    showDropdown = false;
  }

  function clearSelection() {
    selected = null;
    searchQuery = '';
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
</script>

<div class="space-y-1.5">
  <span id={id ? `${id}-label` : undefined} class="text-sm font-medium text-foreground">
    {label}
  </span>

  {#if selected}
    <div
      role="group"
      aria-labelledby={id ? `${id}-label` : undefined}
      class="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
    >
      <span class="flex-1 truncate">{formatOption(selected)}</span>
      <button
        type="button"
        class="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="Clear {label}"
        onclick={clearSelection}
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>
  {:else}
    <div class="relative">
      <input
        bind:this={inputElement}
        {id}
        type="text"
        placeholder="Search by plan number or title..."
        class="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
        bind:value={searchQuery}
        aria-labelledby={id ? `${id}-label` : undefined}
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
          {:else if searchResults && searchResults.length > 0}
            {#each searchResults as option (option.uuid)}
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                onmousedown={(e) => {
                  e.preventDefault();
                  selectOption(option);
                }}
              >
                <span class="flex-1 truncate">{formatOption(option)}</span>
                {#if option.status}
                  <span class="text-xs text-muted-foreground">{option.status}</span>
                {/if}
              </button>
            {/each}
          {:else if searchResults}
            <div class="px-3 py-2 text-sm text-muted-foreground">No matching plans</div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
