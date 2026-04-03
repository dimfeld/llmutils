<script lang="ts">
  import { renderPlanContentHtml } from '$lib/utils/plan_content.js';

  let { content }: { content: string | null } = $props();

  let renderedContent = $derived(content === null ? null : renderPlanContentHtml(content));
</script>

<div class="flex h-full min-h-0 flex-col overflow-y-auto bg-gray-900 p-4 text-sm text-gray-200">
  {#if renderedContent !== null}
    <pre
      class="plan-content font-mono leading-6"
      aria-label="Plan content">{@html renderedContent}</pre>
  {:else}
    <p class="text-gray-500">Waiting for plan content...</p>
  {/if}
</div>

<style>
  .plan-content {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .plan-content :global(.plan-heading) {
    color: rgb(248 250 252);
    font-weight: 700;
  }

  .plan-content :global(.plan-bold) {
    color: rgb(248 250 252);
    font-weight: 700;
  }

  .plan-content :global(.plan-inline-code) {
    background: rgb(15 23 42 / 0.7);
    border-radius: 0.25rem;
    color: rgb(253 224 71);
    padding: 0.1rem 0.3rem;
  }

  .plan-content :global(.plan-code-fence) {
    color: rgb(100 116 139);
  }

  .plan-content :global(.plan-code) {
    color: rgb(226 232 240);
  }

  .plan-content :global(.plan-list-item) {
    color: rgb(226 232 240);
  }

  .plan-content :global(.plan-list-marker) {
    color: rgb(100 116 139);
  }
</style>
