<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { EnrichedProjectPr } from '$lib/remote/project_prs.remote.js';
  import {
    isListNavEvent,
    getAdjacentItem,
    scrollListItemIntoView,
  } from '$lib/utils/keyboard_nav.js';
  import PrRow from './PrRow.svelte';

  let {
    authored,
    reviewing,
    projectId,
    selectedPrNumber,
  }: {
    authored: EnrichedProjectPr[];
    reviewing: EnrichedProjectPr[];
    projectId: string;
    selectedPrNumber: number | null;
  } = $props();

  let searchQuery = $state('');

  let filteredAuthored = $derived.by(() => {
    if (!searchQuery) return authored;
    const query = searchQuery.toLowerCase();
    return authored.filter(
      (pr) =>
        (pr.status.title?.toLowerCase().includes(query) ?? false) ||
        String(pr.status.pr_number).includes(query) ||
        (pr.status.head_branch?.toLowerCase().includes(query) ?? false)
    );
  });

  let filteredReviewing = $derived.by(() => {
    if (!searchQuery) return reviewing;
    const query = searchQuery.toLowerCase();
    return reviewing.filter(
      (pr) =>
        (pr.status.title?.toLowerCase().includes(query) ?? false) ||
        String(pr.status.pr_number).includes(query) ||
        (pr.status.head_branch?.toLowerCase().includes(query) ?? false)
    );
  });

  let visiblePrNumbers = $derived.by(() => {
    const ids: string[] = [];
    for (const pr of filteredAuthored) {
      ids.push(String(pr.status.pr_number));
    }
    for (const pr of filteredReviewing) {
      ids.push(String(pr.status.pr_number));
    }
    return ids;
  });

  function handleKeydown(event: KeyboardEvent) {
    const direction = isListNavEvent(event);
    if (!direction) return;

    event.preventDefault();

    const currentId = selectedPrNumber != null ? String(selectedPrNumber) : null;
    const nextId = getAdjacentItem(visiblePrNumbers, currentId, direction);
    if (!nextId) return;

    void goto(`/projects/${projectId}/prs/${nextId}`).then(() => scrollListItemIntoView(nextId));
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex h-full flex-col">
  <div class="space-y-3 border-b border-border p-3">
    <input
      type="text"
      placeholder="Search pull requests..."
      aria-label="Search pull requests"
      data-search-input
      class="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
      bind:value={searchQuery}
    />
  </div>

  <div class="flex-1 overflow-y-auto">
    {#if filteredAuthored.length > 0}
      <div class="border-b border-border">
        <div
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          My PRs
          <span class="font-normal text-muted-foreground/70">({filteredAuthored.length})</span>
        </div>
        <div class="space-y-0.5 px-2 pb-2">
          {#each filteredAuthored as pr (pr.status.pr_number)}
            <PrRow {pr} {projectId} selected={pr.status.pr_number === selectedPrNumber} />
          {/each}
        </div>
      </div>
    {/if}

    {#if filteredReviewing.length > 0}
      <div class="border-b border-border">
        <div
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          Reviewing
          <span class="font-normal text-muted-foreground/70">({filteredReviewing.length})</span>
        </div>
        <div class="space-y-0.5 px-2 pb-2">
          {#each filteredReviewing as pr (pr.status.pr_number)}
            <PrRow {pr} {projectId} selected={pr.status.pr_number === selectedPrNumber} />
          {/each}
        </div>
      </div>
    {/if}

    {#if filteredAuthored.length === 0 && filteredReviewing.length === 0}
      <div class="flex items-center justify-center p-8 text-sm text-muted-foreground">
        {searchQuery ? 'No pull requests match the search' : 'No relevant pull requests found'}
      </div>
    {/if}
  </div>
</div>
