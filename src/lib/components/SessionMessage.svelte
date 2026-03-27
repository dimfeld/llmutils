<script lang="ts">
  import type { DisplayMessage, DisplayMessageBody } from '$lib/types/session.js';
  import { categoryColorClass } from '$lib/utils/session_colors.js';
  import {
    getDisplayCategory,
    formatStructuredMessage,
    type DisplayCategory,
  } from '$lib/utils/message_formatting.js';
  import {
    getTextTruncationState,
    KV_VALUE_TRUNCATE_CHARS,
    TOOL_USE_TRUNCATE_LINE_LIMIT,
  } from './session_message_truncation.js';
  import ReviewResultDisplay from './ReviewResultDisplay.svelte';

  let { message }: { message: DisplayMessage } = $props();

  let displayCategory: DisplayCategory | null = $derived(
    message.body.type === 'structured' ? getDisplayCategory(message.body.message) : null
  );

  let colorClass = $derived(
    displayCategory ? categoryColorClass(displayCategory) : categoryColorClass(message.category)
  );

  let timeStr = $derived(new Date(message.timestamp).toLocaleTimeString());

  /** The body to render — either the message body directly, or the formatted structured message. */
  let renderBody: DisplayMessageBody | null = $derived.by(() => {
    if (message.body.type !== 'structured') return message.body;
    try {
      return formatStructuredMessage(message.body.message);
    } catch {
      return { type: 'text', text: `[render error: ${message.rawType}]` };
    }
  });

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
    if (renderBody?.type === 'text') return renderBody.text;
    if (renderBody?.type === 'monospaced') return renderBody.text;
    return '';
  });

  let skipTruncation = $derived(
    displayCategory === 'llmOutput' || message.rawType === 'review_result'
  );

  let effectiveLineLimit = $derived(
    displayCategory === 'toolUse' || displayCategory === 'command'
      ? TOOL_USE_TRUNCATE_LINE_LIMIT
      : undefined
  );

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
    (renderBody?.type === 'text' || renderBody?.type === 'monospaced') &&
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

  let isToolUseValues = $derived(displayCategory === 'toolUse');
</script>

<div class="py-0.5 {colorClass}" style:content-visibility="auto">
  <span class="mr-2 text-xs text-gray-400">{timeStr}</span>
  {#if message.body.type === 'structured' && message.body.message.type === 'review_result'}
    <ReviewResultDisplay message={message.body.message} />
  {:else if renderBody?.type === 'text'}
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
  {:else if renderBody?.type === 'monospaced'}
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
  {:else if renderBody?.type === 'todoList'}
    {#if renderBody.explanation}
      <span class="text-gray-400">{renderBody.explanation}</span>
    {/if}
    {#each renderBody.items as item, i (i)}
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
            ? '\u2713'
            : item.status === 'in_progress'
              ? '\u2192'
              : item.status === 'blocked'
                ? '\u2717'
                : item.status === 'unknown'
                  ? '?'
                  : '\u25CB'}
        </span>
        {item.label}
      </div>
    {/each}
  {:else if renderBody?.type === 'fileChanges'}
    {#if renderBody.status}
      <span class="text-gray-400">{renderBody.status}</span>
    {/if}
    {#each renderBody.changes as change, i (change.path + ':' + i)}
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
  {:else if renderBody?.type === 'keyValuePairs'}
    {@const hasLongValues = renderBody.entries.some(
      (e) => getKeyValueTruncationState(e.value, kvExpanded, isToolUseValues).isTruncatable
    )}
    <div class="mt-1 pl-2">
      {#each renderBody.entries as entry (entry.key)}
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
  {:else if renderBody === null}
    <span class="text-gray-400">Unsupported message type: {message.rawType}</span>
  {/if}
</div>
