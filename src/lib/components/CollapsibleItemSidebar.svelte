<script lang="ts">
  import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
  import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils.js';

  let {
    label,
    class: className,
    children,
  }: {
    label: string;
    class?: string;
    children: Snippet;
  } = $props();

  let expanded: boolean = $state(true);
</script>

{#if expanded}
  <aside class={cn('relative w-96 shrink-0 border-r border-border', className)} aria-label={label}>
    <button
      type="button"
      class="absolute top-2 right-0 z-20 flex size-7 translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
      aria-label={`Collapse ${label}`}
      aria-expanded="true"
      onclick={() => (expanded = false)}
    >
      <PanelLeftClose size={15} />
    </button>
    {@render children()}
  </aside>
{:else}
  <div class="relative w-0 shrink-0">
    <button
      type="button"
      class="absolute top-2 left-2 z-20 flex size-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
      aria-label={`Expand ${label}`}
      aria-expanded="false"
      onclick={() => (expanded = true)}
    >
      <PanelLeftOpen size={15} />
    </button>
  </div>
{/if}
