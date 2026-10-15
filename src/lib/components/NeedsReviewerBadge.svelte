<script lang="ts">
  import UserPlus from '@lucide/svelte/icons/user-plus';

  let { compact = false }: { compact?: boolean } = $props();
</script>

<span
  class="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet-100 px-1.5 py-0.5 leading-none font-medium text-violet-800 dark:bg-violet-950/60 dark:text-violet-200 {compact
    ? 'text-[10px]'
    : 'text-xs'}"
  title="Open, but no human reviewer is requested yet"
>
  <UserPlus class={compact ? 'size-2.5' : 'size-3'} aria-hidden="true" />
  No reviewer
</span>
