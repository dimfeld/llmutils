<script lang="ts">
  import { renderMarkdown } from '$lib/utils/markdown_parser.js';

  let { content }: { content: string | null } = $props();

  let renderedContent = $derived(content === null ? null : renderMarkdown(content));
</script>

<div class="flex h-full min-h-0 flex-col overflow-y-auto bg-gray-900 p-4 text-sm text-gray-200">
  {#if renderedContent}
    <div class="plan-content" tabindex="0" role="region" aria-label="Plan content">
      {@html renderedContent}
    </div>
  {:else}
    <p class="text-gray-500">Waiting for plan content...</p>
  {/if}
</div>

<style>
  .plan-content {
    margin: 0;
    word-break: break-word;
    outline: none;
  }

  .plan-content:focus-visible {
    outline: 2px solid rgb(99 102 241);
    outline-offset: 2px;
    border-radius: 0.25rem;
  }

  .plan-content :global(:is(h1, h2, h3, h4, h5, h6)) {
    color: rgb(248 250 252);
    font-weight: 700;
    margin-top: 0.75em;
    margin-bottom: 0.25em;
  }

  .plan-content :global(h1) {
    font-size: 1.25em;
  }

  .plan-content :global(h2) {
    font-size: 1.1em;
  }

  .plan-content :global(h3) {
    font-size: 1em;
  }

  .plan-content :global(:is(h4, h5, h6)) {
    font-size: 0.9em;
  }

  .plan-content :global(> :first-child) {
    margin-top: 0;
  }

  .plan-content :global(strong) {
    color: rgb(248 250 252);
    font-weight: 700;
  }

  .plan-content :global(code) {
    background: rgb(15 23 42 / 0.7);
    border-radius: 0.25rem;
    color: rgb(253 224 71);
    font-family: ui-monospace, monospace;
    font-size: 0.9em;
    padding: 0.1rem 0.3rem;
  }

  .plan-content :global(pre) {
    background: rgb(15 23 42 / 0.5);
    border-radius: 0.375rem;
    color: rgb(226 232 240);
    font-family: ui-monospace, monospace;
    font-size: 0.9em;
    padding: 0.6rem 0.75rem;
    margin-top: 0.5em;
    margin-bottom: 0.5em;
    overflow-x: auto;
  }

  .plan-content :global(pre code) {
    background: none;
    border-radius: 0;
    color: inherit;
    padding: 0;
  }

  .plan-content :global(:is(ul, ol)) {
    padding-left: 1.5em;
    margin-top: 0.25em;
    margin-bottom: 0.25em;
  }

  .plan-content :global(ul) {
    list-style-type: disc;
  }

  .plan-content :global(ol) {
    list-style-type: decimal;
  }

  .plan-content :global(li::marker) {
    color: rgb(100 116 139);
  }
</style>
