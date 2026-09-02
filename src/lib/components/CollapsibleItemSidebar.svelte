<script lang="ts">
  import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
  import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import { afterNavigate } from '$app/navigation';
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils.js';

  let {
    label,
    class: className,
    detailActive = false,
    detailClass,
    children,
    detail,
  }: {
    label: string;
    /** Extra classes for the list pane. */
    class?: string;
    /**
     * True when a child route is showing an item in the detail pane. On small screens only one
     * pane is visible at a time: the list when nothing is selected, the detail otherwise.
     */
    detailActive?: boolean;
    /** Extra classes for the detail pane wrapper. */
    detailClass?: string;
    /** The list pane contents. */
    children: Snippet;
    /** The detail pane contents. Omit to render only the list pane. */
    detail?: Snippet;
  } = $props();

  /** Desktop collapse state. */
  let expanded: boolean = $state(true);
  /** On small screens, show the list instead of the active detail. */
  let mobileListOpen: boolean = $state(false);

  // Picking an item (or any other navigation) returns to the detail pane on small screens.
  afterNavigate(() => {
    mobileListOpen = false;
  });

  let showListOnMobile = $derived(!detailActive || mobileListOpen);
</script>

<div class="flex h-full min-h-0 w-full">
  {#if expanded}
    <aside
      class={cn(
        'relative w-full shrink-0 border-border md:w-96 md:border-r',
        showListOnMobile ? 'block' : 'hidden md:block',
        className
      )}
      aria-label={label}
    >
      <button
        type="button"
        class="absolute top-2 right-0 z-20 hidden size-7 translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:bg-gray-100 hover:text-foreground md:flex dark:hover:bg-gray-800"
        aria-label={`Collapse ${label}`}
        aria-expanded="true"
        onclick={() => (expanded = false)}
      >
        <PanelLeftClose size={15} />
      </button>
      {@render children()}
    </aside>
  {:else}
    <div class="relative hidden w-0 shrink-0 md:block">
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

  {#if detail}
    <div
      class={cn('min-h-0 min-w-0 flex-1 flex-col', showListOnMobile ? 'hidden md:flex' : 'flex')}
    >
      {#if detailActive}
        <div class="flex shrink-0 items-center border-b border-border md:hidden">
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            aria-label={`Back to ${label}`}
            onclick={() => (mobileListOpen = true)}
          >
            <ChevronLeft size={16} />
            {label}
          </button>
        </div>
      {/if}
      <div class={cn('min-h-0 min-w-0 flex-1', detailClass)}>
        {@render detail()}
      </div>
    </div>
  {/if}
</div>
