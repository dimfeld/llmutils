<script lang="ts">
  import GitMergeConflict from '@lucide/svelte/icons/git-merge-conflict';
</script>

<span
  class="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-100 px-1.5 py-0.5 text-xs leading-none font-medium text-red-800 dark:bg-red-900/30 dark:text-red-300"
  title="Has merge conflicts that must be resolved before merging"
>
  <GitMergeConflict class="size-3" aria-hidden="true" />
  Conflicts
</span>
