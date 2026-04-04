<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    count,
    defaultCollapsed = false,
    children,
  }: {
    title: string;
    count: number;
    defaultCollapsed?: boolean;
    children: Snippet;
  } = $props();

  let collapsed = $state(defaultCollapsed);
</script>

<section>
  <button
    type="button"
    class="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
    aria-expanded={!collapsed}
    aria-label="Toggle {title} section"
    onclick={() => (collapsed = !collapsed)}
  >
    <span class="text-[10px] text-muted-foreground/70" aria-hidden="true"
      >{collapsed ? '▶' : '▼'}</span
    >
    <span class="min-w-0 flex-1 truncate">{title}</span>
    <span
      class="shrink-0 rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300"
    >
      {count}
    </span>
  </button>

  {#if !collapsed}
    <div class="mt-1 flex flex-col gap-1">
      {@render children()}
    </div>
  {/if}
</section>
