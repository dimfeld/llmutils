<script lang="ts">
  let { content }: { content: string | null } = $props();
</script>

<div class="flex h-full min-h-0 flex-col overflow-y-auto bg-gray-900 p-4 font-mono text-sm">
  {#if content != null}
    <pre class="break-words whitespace-pre-wrap text-gray-200">{content}</pre>
  {:else}
    <p class="text-gray-500">Waiting for plan content...</p>
  {/if}
</div>
