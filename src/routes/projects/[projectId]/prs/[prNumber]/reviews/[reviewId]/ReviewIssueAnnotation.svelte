<script lang="ts">
  import StickyNote from '@lucide/svelte/icons/sticky-note';
  import { renderMarkdown } from '$lib/utils/markdown_parser.js';
  import type { ReviewSeverity } from '$tim/db/review.js';

  interface Props {
    issueId: number;
    severity: ReviewSeverity;
    content: string;
    suggestion: string | null;
    lineLabel: string | null;
    resolved: boolean;
    onClick: (issueId: number) => void;
  }

  let { issueId, severity, content, suggestion, lineLabel, resolved, onClick }: Props = $props();

  let isNote = $derived(severity === 'note');

  const SEVERITY_COLORS: Record<ReviewSeverity, string> = {
    critical: '#dc2626',
    major: '#ea580c',
    minor: '#ca8a04',
    info: '#2563eb',
    note: '#64748b',
  };

  function handleClick(event: MouseEvent) {
    event.stopPropagation();
    onClick(issueId);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    onClick(issueId);
  }
</script>

<div
  role="button"
  tabindex="0"
  onclick={handleClick}
  onkeydown={handleKeydown}
  title={lineLabel ? `${content} (${lineLabel})` : content}
  class="relative mx-1 flex w-full flex-col gap-2 rounded px-2 py-1"
  style="
    border: 1px solid rgba(148, 163, 184, 0.35);
    background: rgba(148, 163, 184, 0.08);
    color: {resolved ? 'rgba(100, 116, 139, 0.95)' : 'inherit'};
    font-size: 12px;
    line-height: 1.3;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
  "
>
  {#if resolved}
    <div class="absolute inset-0 z-10 bg-gray-500/30"></div>
  {/if}
  <div style="display: flex; align-items: flex-start; gap: 6px; min-width: 0;">
    {#if isNote}
      <StickyNote
        aria-hidden="true"
        class="mt-0.5 size-3.5 shrink-0"
        style="color: {resolved ? 'rgba(100, 116, 139, 0.95)' : SEVERITY_COLORS[severity]};"
      />
    {:else}
      <span
        aria-hidden="true"
        class="mt-1 size-2 rounded-full"
        style="
          flex-shrink: 0;
          background: {resolved ? 'rgba(100, 116, 139, 0.95)' : SEVERITY_COLORS[severity]};
        "
      ></span>
    {/if}
    {#if isNote}
      <div
        class="min-w-0 flex-1 whitespace-pre-wrap"
        style="overflow-wrap: anywhere; font-family: inherit;"
      >
        {content}
      </div>
    {:else}
      <div class="plan-rendered-content min-w-0 flex-1" style="overflow-wrap: anywhere">
        {@html renderMarkdown(content)}
      </div>
    {/if}
  </div>
  {#if suggestion}
    <div
      class="plan-rendered-content min-w-0"
      style="
        margin-left: 14px;
        overflow-wrap: anywhere;
      "
    >
      <div class="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        Suggestion
      </div>
      {#if severity === 'note'}
        <div class="whitespace-pre-wrap">{suggestion}</div>
      {:else}
        {@html renderMarkdown(suggestion)}
      {/if}
    </div>
  {/if}
  {#if lineLabel}
    <span
      aria-hidden="true"
      style="
        margin-left: 14px;
        flex-shrink: 0;
        color: rgba(71, 85, 105, 0.8);
        font-size: 10px;
        white-space: nowrap;
      "
    >
      {lineLabel}
    </span>
  {/if}
</div>
