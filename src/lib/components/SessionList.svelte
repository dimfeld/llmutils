<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import type { SessionGroup } from '$lib/types/session.js';
  import SessionRow from './SessionRow.svelte';

  let {
    groups,
    selectedSessionId,
    onselect,
  }: {
    groups: SessionGroup[];
    selectedSessionId: string | null;
    onselect: (connectionId: string) => void;
  } = $props();

  // Track which groups are collapsed
  let collapsed = new SvelteSet<string>();

  function toggleGroup(groupKey: string) {
    if (collapsed.has(groupKey)) {
      collapsed.delete(groupKey);
    } else {
      collapsed.add(groupKey);
    }
  }
</script>

{#if groups.length === 0}
  <div class="flex flex-1 items-center justify-center p-8">
    <p class="text-sm text-gray-400">No sessions</p>
  </div>
{:else}
  <div class="flex flex-col gap-1 p-2">
    {#each groups as group (group.groupKey)}
      {@const isCollapsed = collapsed.has(group.groupKey)}
      <div>
        <button
          type="button"
          class="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs font-semibold tracking-wide text-gray-500 uppercase transition-colors hover:bg-gray-100"
          onclick={() => toggleGroup(group.groupKey)}
        >
          <span class="text-[10px] text-gray-400">{isCollapsed ? '▶' : '▼'}</span>
          <span class="min-w-0 flex-1 truncate">{group.label}</span>
          <span class="shrink-0 text-[10px] font-normal text-gray-400">
            {group.sessions.length}
          </span>
        </button>

        {#if !isCollapsed}
          <div class="mt-0.5 flex flex-col gap-0.5">
            {#each group.sessions as session (session.connectionId)}
              <SessionRow
                {session}
                selected={session.connectionId === selectedSessionId}
                {onselect}
              />
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
