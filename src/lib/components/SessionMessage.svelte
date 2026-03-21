<script lang="ts">
  import type { DisplayMessage } from '$lib/types/session.js';
  import { categoryColorClass } from '$lib/utils/session_colors.js';
  import {
    getTextTruncationState,
    KV_VALUE_TRUNCATE_CHARS,
    TOOL_USE_TRUNCATE_LINE_LIMIT,
  } from './session_message_truncation.js';

  let { message }: { message: DisplayMessage } = $props();

  let colorClass = $derived(categoryColorClass(message.category));
  let timeStr = $derived(new Date(message.timestamp).toLocaleTimeString());

  let expanded = $state(false);
  let kvExpanded = $state(false);

  function getKeyValueTruncationState(value: string, expanded: boolean, isToolUse: boolean) {
    if (isToolUse) {
      return getTextTruncationState(value, expanded, {
        lineLimit: TOOL_USE_TRUNCATE_LINE_LIMIT,
      });
    }

    return getTextTruncationState(value, expanded, {
      charLimit: KV_VALUE_TRUNCATE_CHARS,
    });
  }

  let textContent = $derived.by(() => {
    if (message.body.type === 'text') return message.body.text;
    if (message.body.type === 'monospaced') return message.body.text;
    return '';
  });

  let skipTruncation = $derived(
    message.category === 'llmOutput' || message.rawType === 'review_result'
  );
  let effectiveLineLimit = $derived(
    message.category === 'toolUse' || message.category === 'command'
      ? TOOL_USE_TRUNCATE_LINE_LIMIT
      : undefined
  );

  let lineCount = $derived(textContent.split('\n').length);
  let textTruncation = $derived(
    skipTruncation
      ? {
          isTruncatable: false,
          displayText: textContent,
          hiddenLineCount: 0,
          hiddenCharCount: 0,
          truncationMode: 'none' as const,
        }
      : getTextTruncationState(textContent, expanded, { lineLimit: effectiveLineLimit })
  );
  let isTruncatable = $derived(
    (message.body.type === 'text' || message.body.type === 'monospaced') &&
      textTruncation.isTruncatable
  );
  let displayText = $derived(textTruncation.displayText);
  let expandLabel = $derived.by(() => {
    if (expanded) return 'Show less';
    if (textTruncation.truncationMode === 'lines') {
      return `Show more (${textTruncation.hiddenLineCount} more lines)`;
    }

    return `Show more (${textTruncation.hiddenCharCount} more chars)`;
  });
</script>

<div class="py-0.5 {colorClass}">
  <span class="mr-2 text-xs text-gray-400">{timeStr}</span>
  {#if message.body.type === 'text'}
    <span class="whitespace-pre-wrap">{displayText}</span>
    {#if isTruncatable}
      <button
        type="button"
        class="ml-1 text-xs text-gray-400 hover:text-gray-300"
        onclick={() => (expanded = !expanded)}
      >
        {expandLabel}
      </button>
    {/if}
  {:else if message.body.type === 'monospaced'}
    <pre class="mt-1 whitespace-pre-wrap">{displayText}</pre>
    {#if isTruncatable}
      <button
        type="button"
        class="ml-1 text-xs text-gray-400 hover:text-gray-300"
        onclick={() => (expanded = !expanded)}
      >
        {expandLabel}
      </button>
    {/if}
  {:else if message.body.type === 'todoList'}
    {#if message.body.explanation}
      <span class="text-gray-400">{message.body.explanation}</span>
    {/if}
    {#each message.body.items as item, i (i)}
      <div class="pl-2">
        <span
          class={item.status === 'completed'
            ? 'text-green-400'
            : item.status === 'in_progress'
              ? 'text-blue-400'
              : item.status === 'blocked'
                ? 'text-red-400'
                : 'text-gray-400'}
        >
          {item.status === 'completed'
            ? '✓'
            : item.status === 'in_progress'
              ? '→'
              : item.status === 'blocked'
                ? '✗'
                : item.status === 'unknown'
                  ? '?'
                  : '○'}
        </span>
        {item.label}
      </div>
    {/each}
  {:else if message.body.type === 'fileChanges'}
    {#if message.body.status}
      <span class="text-gray-400">{message.body.status}</span>
    {/if}
    {#each message.body.changes as change, i (change.path + ':' + i)}
      <div class="pl-2">
        <span
          class={change.kind === 'added'
            ? 'text-green-400'
            : change.kind === 'removed'
              ? 'text-red-400'
              : 'text-cyan-400'}
        >
          {change.kind === 'added' ? '+' : change.kind === 'removed' ? '-' : '~'}
        </span>
        {change.path}
      </div>
    {/each}
  {:else if message.body.type === 'keyValuePairs'}
    {@const isToolUseValues = message.category === 'toolUse'}
    {@const hasLongValues = message.body.entries.some(
      (e) => getKeyValueTruncationState(e.value, kvExpanded, isToolUseValues).isTruncatable
    )}
    <div class="mt-1 pl-2">
      {#each message.body.entries as entry (entry.key)}
        {@const entryTruncation = getKeyValueTruncationState(
          entry.value,
          kvExpanded,
          isToolUseValues
        )}
        <div class="flex gap-2">
          <span class="shrink-0 text-gray-400">{entry.key}:</span>
          <span class="whitespace-pre-wrap">{entryTruncation.displayText}</span>
        </div>
      {/each}
      {#if hasLongValues}
        <button
          type="button"
          class="mt-1 text-xs text-gray-400 hover:text-gray-300"
          onclick={() => (kvExpanded = !kvExpanded)}
        >
          {kvExpanded ? 'Show less' : 'Show more'}
        </button>
      {/if}
    </div>
  {/if}
</div>
