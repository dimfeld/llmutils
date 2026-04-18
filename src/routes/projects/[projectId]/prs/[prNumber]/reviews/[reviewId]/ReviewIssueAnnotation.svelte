<script lang="ts">
  import { renderMarkdown } from '$lib/utils/markdown_parser.js';
  import type { ReviewSeverity } from '$tim/db/review.js';

  interface Props {
    issueId: number;
    severity: ReviewSeverity;
    content: string;
    suggestion: string | null;
    lineLabel: string | null;
    onClick: (issueId: number) => void;
  }

  let { issueId, severity, content, suggestion, lineLabel, onClick }: Props = $props();

  const SEVERITY_COLORS: Record<ReviewSeverity, string> = {
    critical: '#dc2626',
    major: '#ea580c',
    minor: '#ca8a04',
    info: '#2563eb',
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
  style="
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    padding: 4px 8px;
    margin: 2px 0;
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 4px;
    background: rgba(148, 163, 184, 0.08);
    color: inherit;
    font-size: 12px;
    line-height: 1.3;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
  "
>
  <div style="display: flex; align-items: flex-start; gap: 6px; min-width: 0;">
    <span
      aria-hidden="true"
      style="
        width: 8px;
        height: 8px;
        margin-top: 4px;
        border-radius: 50%;
        flex-shrink: 0;
        background: {SEVERITY_COLORS[severity]};
      "
    ></span>
    <div
      class="plan-rendered-content"
      style="
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
      "
    >
      {@html renderMarkdown(content)}
    </div>
  </div>
  {#if suggestion}
    <div
      class="plan-rendered-content"
      style="
        margin-left: 14px;
        min-width: 0;
        overflow-wrap: anywhere;
      "
    >
      <div class="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        Suggestion
      </div>
      {@html renderMarkdown(suggestion)}
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
