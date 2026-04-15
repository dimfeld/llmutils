<script lang="ts">
  import CheckCircle from '@lucide/svelte/icons/check-circle';
  import Circle from '@lucide/svelte/icons/circle';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import type { ReviewIssueRow, ReviewCategory } from '$tim/db/review.js';
  import CopyButton from '$lib/components/CopyButton.svelte';

  interface Props {
    issue: ReviewIssueRow;
    actioning: boolean;
    linkedPlanUuid: string | null;
    categoryBadgeClass: (category: ReviewCategory) => string;
    issueLocationLabel: (issue: ReviewIssueRow) => string | null;
    formatCategory: (category: ReviewCategory) => string;
    onCopyError?: (message: string) => void;
    onToggleResolved: (issue: ReviewIssueRow) => void;
    onDelete: (issue: ReviewIssueRow) => void;
    onAddToPlan: (issue: ReviewIssueRow) => void;
  }

  let {
    issue,
    actioning,
    linkedPlanUuid,
    categoryBadgeClass,
    issueLocationLabel,
    formatCategory,
    onCopyError,
    onToggleResolved,
    onDelete,
    onAddToPlan,
  }: Props = $props();

  let expanded = $state(!issue.resolved);

  function handleToggleResolved() {
    const wasResolved = issue.resolved;
    onToggleResolved(issue);
    // Collapse when marking as resolved, expand when marking as unresolved
    if (!wasResolved) {
      expanded = false;
    }
  }

  function issueCopyText(): string {
    const parts: string[] = [];
    const location = issueLocationLabel(issue);
    if (location) {
      parts.push(location);
    }

    const content = issue.content.trim();
    if (content) {
      parts.push(content);
    }

    const suggestion = issue.suggestion?.trim();
    if (suggestion) {
      parts.push(`Suggestion:\n${suggestion}`);
    }

    return parts.join('\n\n');
  }
</script>

<li
  class="rounded-md border border-border bg-card text-xs @sm:text-sm {issue.resolved
    ? 'opacity-50'
    : ''}"
>
  <!-- Header row: always visible -->
  <button
    type="button"
    onclick={() => (expanded = !expanded)}
    class="flex w-full cursor-pointer items-start gap-1.5 px-2.5 pt-2.5 text-left {expanded
      ? 'pb-1.5'
      : 'pb-2.5'}"
    aria-expanded={expanded}
  >
    <span class="mt-0.5 shrink-0 text-muted-foreground">
      {#if expanded}
        <ChevronDown class="size-3 @sm:size-3.5" />
      {:else}
        <ChevronRight class="size-3 @sm:size-3.5" />
      {/if}
    </span>
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-1">
        <span
          class="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium @sm:text-xs {categoryBadgeClass(
            issue.category
          )}"
        >
          {formatCategory(issue.category)}
        </span>
        {#if issue.resolved}
          <span
            class="inline-flex items-center rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-medium text-emerald-800 @sm:text-xs dark:bg-emerald-900/30 dark:text-emerald-300"
          >
            Resolved
          </span>
        {/if}
        {#if issue.file}
          <span class="truncate font-mono text-[10px] text-muted-foreground @sm:text-xs">
            {issueLocationLabel(issue)}
          </span>
        {/if}
      </div>
      {#if !expanded}
        <p class="mt-0.5 truncate text-foreground/70">{issue.content}</p>
      {/if}
    </div>
  </button>

  <!-- Expanded content -->
  {#if expanded}
    <div class="space-y-2 px-2.5 pb-2.5 pl-7">
      <div class="space-y-1">
        <p class="text-foreground">{issue.content}</p>
        {#if issue.suggestion}
          <p class="text-muted-foreground">
            <span class="font-medium text-foreground">Suggestion:</span>
            {issue.suggestion}
          </p>
        {/if}
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onclick={() => onDelete(issue)}
          disabled={actioning}
          class="rounded border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 @sm:text-xs dark:hover:bg-gray-800"
        >
          Delete issue
        </button>

        {#if linkedPlanUuid}
          <button
            type="button"
            onclick={() => onAddToPlan(issue)}
            disabled={actioning}
            class="rounded border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 @sm:text-xs dark:hover:bg-gray-800"
          >
            Add to plan as a task
          </button>
        {/if}

        {#if issue.file}
          <CopyButton
            text={issue.file}
            mode="text-with-icon"
            label="Copy file path"
            iconClass="size-3 @sm:size-3.5"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 @sm:text-xs dark:hover:bg-gray-800"
            copiedClass="text-emerald-600 dark:text-emerald-400"
            title="Copy file path"
            ariaLabel="Copy file path"
            disabled={actioning}
          />
        {/if}

        <button
          type="button"
          onclick={handleToggleResolved}
          disabled={actioning}
          class="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 @sm:text-xs dark:hover:bg-gray-800"
          title={issue.resolved ? 'Mark as unresolved' : 'Mark as resolved'}
          aria-label={issue.resolved ? 'Mark as unresolved' : 'Mark as resolved'}
        >
          {#if issue.resolved}
            <CheckCircle class="size-3 @sm:size-3.5" />
          {:else}
            <Circle class="size-3 @sm:size-3.5" />
          {/if}
          {issue.resolved ? 'Mark unresolved' : 'Mark resolved'}
        </button>

          <CopyButton
            text={issueCopyText()}
            mode="icon"
            iconClass="size-3.5 @sm:size-4"
            className="ml-auto rounded p-1 transition-colors text-muted-foreground hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
            copiedClass="text-emerald-600 dark:text-emerald-400"
            failedClass="text-red-600 dark:text-red-400"
            title="Copy file/line, issue content, and suggestion"
            ariaLabel="Copy issue details"
            disabled={actioning}
            onCopyError={(message) => onCopyError?.(message)}
          />
      </div>
    </div>
  {/if}
</li>
