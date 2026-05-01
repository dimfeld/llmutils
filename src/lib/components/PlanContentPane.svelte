<script lang="ts">
  import { renderMarkdown } from '$lib/utils/markdown_parser.js';
  import type { SessionPlanTask } from '$lib/types/session.js';

  let { content, tasks = [] }: { content: string | null; tasks?: SessionPlanTask[] } = $props();

  let renderedContent = $derived(content === null ? null : renderMarkdown(content));
  let completedTaskCount = $derived(tasks.filter((task) => task.done).length);
</script>

<div class="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-gray-900 p-4 text-sm text-gray-200">
  {#if tasks.length > 0}
    <section class="plan-tasks" aria-label="Plan tasks">
      <div class="mb-2 flex items-center justify-between gap-3">
        <h3 class="text-xs font-semibold tracking-normal text-gray-100 uppercase">Tasks</h3>
        <span class="shrink-0 text-xs text-gray-400 tabular-nums">
          {completedTaskCount}/{tasks.length}
        </span>
      </div>
      <ol class="space-y-2">
        {#each tasks as task, index (`${index}-${task.title}`)}
          {#if task.done}
            <li class="task-item task-item--done rounded border border-gray-800 bg-gray-950/40 p-2">
              <details class="group">
                <summary class="flex cursor-pointer gap-2 list-none items-start">
                  <span
                    class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border border-emerald-500 bg-emerald-500 text-[10px] leading-none text-gray-950"
                    aria-label="Done"
                  >
                    ✓
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="font-medium break-words text-gray-100">{task.title}</div>
                  </div>
                </summary>
                {#if task.description}
                  <div class="mt-2 pl-6 whitespace-pre-wrap break-words text-xs text-gray-400">
                    {task.description}
                  </div>
                {/if}
              </details>
            </li>
          {:else}
            <li class="flex gap-2 rounded border border-gray-800 bg-gray-950/40 p-2">
              <span
                class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border text-[10px] leading-none border-gray-600 text-transparent"
                aria-label="Not done"
              >
                ✓
              </span>
              <div class="min-w-0">
                <div class="font-medium break-words text-gray-100">{task.title}</div>
                {#if task.description}
                  <div class="mt-1 whitespace-pre-wrap break-words text-xs text-gray-400">
                    {task.description}
                  </div>
                {/if}
              </div>
            </li>
          {/if}
        {/each}
      </ol>
    </section>
  {/if}

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

  .task-item :global(summary::-webkit-details-marker) {
    display: none;
  }

  .task-item :global(summary::marker) {
    content: '';
  }

  .task-item :global(summary) {
    list-style: none;
  }
</style>
