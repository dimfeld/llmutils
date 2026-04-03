<script lang="ts">
  import { renderPlanContentHtml } from '$lib/utils/plan_content.js';

  let { content }: { content: string | null } = $props();

  let renderedContent = $derived(content === null ? null : renderPlanContentHtml(content));
</script>

<div class="flex h-full min-h-0 flex-col overflow-y-auto bg-gray-900 p-4 text-sm text-gray-200">
  {#if renderedContent !== null}
    <div
      class="plan-content font-mono leading-6 break-words whitespace-pre-wrap"
      aria-label="Plan content"
    >
      {@html renderedContent}
    </div>
  {:else}
    <p class="text-gray-500">Waiting for plan content...</p>
  {/if}
</div>

<style>
  .plan-content :global(h1),
  .plan-content :global(h2),
  .plan-content :global(h3),
  .plan-content :global(h4),
  .plan-content :global(h5),
  .plan-content :global(h6) {
    color: rgb(248 250 252);
    font-weight: 700;
    line-height: 1.3;
    margin: 0 0 0.75rem;
  }

  .plan-content :global(h1) {
    font-size: 1.25rem;
  }

  .plan-content :global(h2) {
    font-size: 1.125rem;
  }

  .plan-content :global(h3),
  .plan-content :global(h4),
  .plan-content :global(h5),
  .plan-content :global(h6) {
    font-size: 1rem;
  }

  .plan-content :global(p),
  .plan-content :global(ul),
  .plan-content :global(pre) {
    margin: 0 0 1rem;
  }

  .plan-content :global(ul) {
    list-style: disc;
    padding-left: 1.5rem;
  }

  .plan-content :global(li + li) {
    margin-top: 0.25rem;
  }

  .plan-content :global(a) {
    color: rgb(125 211 252);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .plan-content :global(strong) {
    color: rgb(248 250 252);
    font-weight: 700;
  }

  .plan-content :global(em) {
    color: rgb(226 232 240);
    font-style: italic;
  }

  .plan-content :global(code) {
    background: rgb(15 23 42 / 0.7);
    border-radius: 0.25rem;
    color: rgb(253 224 71);
    padding: 0.1rem 0.3rem;
  }

  .plan-content :global(pre) {
    background: rgb(15 23 42 / 0.8);
    border: 1px solid rgb(51 65 85);
    border-radius: 0.5rem;
    overflow-x: auto;
    padding: 0.75rem 1rem;
    white-space: pre-wrap;
  }

  .plan-content :global(pre code) {
    background: transparent;
    border-radius: 0;
    color: rgb(226 232 240);
    padding: 0;
  }
</style>
