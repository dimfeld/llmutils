<script lang="ts">
  import CheckCircle from '@lucide/svelte/icons/check-circle';
  import Circle from '@lucide/svelte/icons/circle';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Pencil from '@lucide/svelte/icons/pencil';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash from '@lucide/svelte/icons/trash';
  import { untrack } from 'svelte';
  import type { ReviewIssueRow, ReviewCategory, PrReviewSubmissionRow } from '$tim/db/review.js';
  import CopyButton from '$lib/components/CopyButton.svelte';
  import ReviewIssueEditor from './ReviewIssueEditor.svelte';
  import type { ReviewIssuePatch } from './review_issue_editor_utils.js';

  interface Props {
    issue: ReviewIssueRow;
    actioning: boolean;
    linkedPlanUuid: string | null;
    submission?: PrReviewSubmissionRow | null;
    rootId?: string;
    highlighted?: boolean;
    categoryBadgeClass: (category: ReviewCategory) => string;
    issueLocationLabel: (issue: ReviewIssueRow) => string | null;
    formatCategory: (category: ReviewCategory) => string;
    onCopyError?: (message: string) => void;
    onToggleResolved: (issue: ReviewIssueRow) => void;
    onDelete: (issue: ReviewIssueRow) => void;
    onAddToPlan: (issue: ReviewIssueRow) => void;
    onSaveEdit: (issue: ReviewIssueRow, patch: ReviewIssuePatch) => Promise<void>;
    onJumpToDiff?: (issue: ReviewIssueRow) => void;
  }

  let {
    issue,
    actioning,
    linkedPlanUuid,
    submission = null,
    rootId,
    highlighted = false,
    categoryBadgeClass,
    issueLocationLabel,
    formatCategory,
    onCopyError,
    onToggleResolved,
    onDelete,
    onAddToPlan,
    onSaveEdit,
    onJumpToDiff,
  }: Props = $props();

  let canJumpToDiff = $derived(Boolean(onJumpToDiff && issue.file && issue.line));

  let expanded = $state(untrack(() => !issue.resolved));
  let editing = $state(false);
  let saving = $state(false);

  async function handleSave(patch: ReviewIssuePatch) {
    saving = true;
    try {
      await onSaveEdit(issue, patch);
      editing = false;
    } finally {
      saving = false;
    }
  }

  function handleCancel() {
    editing = false;
  }

  function startEditing() {
    expanded = true;
    editing = true;
  }

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
  id={rootId}
  data-highlighted={highlighted ? 'true' : undefined}
  class="rounded-md border border-border bg-card text-xs transition-shadow duration-500 data-[highlighted=true]:ring-2 data-[highlighted=true]:ring-blue-500 data-[highlighted=true]:ring-offset-2 data-[highlighted=true]:ring-offset-background @sm:text-sm {issue.resolved
    ? 'opacity-50'
    : ''}"
>
  <!-- Header row: always visible -->
  <button
    type="button"
    onclick={() => {
      if (editing || saving) return;
      expanded = !expanded;
    }}
    disabled={editing || saving}
    class="flex w-full cursor-pointer items-start gap-1.5 px-2.5 pt-2.5 text-left {expanded
      ? 'pb-1.5'
      : 'pb-2.5'} disabled:cursor-default"
    aria-expanded={expanded}
    title={editing || saving ? 'Cancel edit to collapse' : undefined}
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
        {#if issue.submittedInPrReviewId != null}
          {#if submission?.githubReviewUrl}
            <a
              href={submission.githubReviewUrl}
              target="_blank"
              rel="noreferrer"
              onclick={(e) => e.stopPropagation()}
              class="inline-flex items-center rounded bg-indigo-100 px-1 py-0.5 text-[10px] font-medium text-indigo-800 hover:underline @sm:text-xs dark:bg-indigo-900/30 dark:text-indigo-300"
            >
              Submitted in review #{submission.githubReviewId ?? submission.id}
            </a>
          {:else}
            <span
              class="inline-flex items-center rounded bg-indigo-100 px-1 py-0.5 text-[10px] font-medium text-indigo-800 @sm:text-xs dark:bg-indigo-900/30 dark:text-indigo-300"
            >
              Submitted in review #{submission?.githubReviewId ?? issue.submittedInPrReviewId}
            </span>
          {/if}
        {/if}
        {#if issue.file}
          <span
            class="font-mono text-[10px] [overflow-wrap:anywhere] whitespace-normal text-muted-foreground @sm:text-xs"
          >
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
      {#if editing}
        <ReviewIssueEditor {issue} {saving} onSave={handleSave} onCancel={handleCancel} />
      {:else}
        <div class="space-y-1">
          <p class="text-foreground">{issue.content}</p>
          {#if issue.suggestion}
            <p class="text-muted-foreground">
              <span class="font-medium text-foreground">Suggestion:</span>
              {issue.suggestion}
            </p>
          {/if}
        </div>

        <div class="space-y-1.5">
          <div class="flex flex-wrap items-center gap-1.5">
            {#if canJumpToDiff}
              <button
                type="button"
                onclick={() => onJumpToDiff?.(issue)}
                disabled={actioning}
                class="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 @sm:text-xs dark:hover:bg-gray-800"
                title="Jump to this issue in the diff"
              >
                <ExternalLink class="size-3 @sm:size-3.5" />
                Jump to diff
              </button>
            {/if}

            {#if issue.file}
              <CopyButton
                text={issue.file}
                mode="icon-with-text"
                label="Copy file path"
                iconClass="size-3 @sm:size-3.5"
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 @sm:text-xs dark:hover:bg-gray-800"
                copiedClass="text-emerald-600 dark:text-emerald-400"
                title="Copy file path"
                ariaLabel="Copy file path"
                disabled={actioning}
              />
            {/if}

            <CopyButton
              text={issueCopyText()}
              mode="icon-with-text"
              label="Copy issue"
              iconClass="size-3 @sm:size-3.5"
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] font-medium text-blue-600 transition-colors hover:bg-gray-100 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50 @sm:text-xs dark:text-blue-400 dark:hover:text-blue-300 dark:hover:bg-gray-800"
              copiedClass="text-emerald-600 dark:text-emerald-400"
              failedClass="text-red-600 dark:text-red-400"
              title="Copy file/line, issue content, and suggestion"
              ariaLabel="Copy issue details"
              disabled={actioning}
              onCopyError={(message) => onCopyError?.(message)}
            />
          </div>

          <div class="flex flex-wrap items-center gap-1.5">
            {#if linkedPlanUuid}
              <button
                type="button"
                onclick={() => onAddToPlan(issue)}
                disabled={actioning}
                class="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 @sm:text-xs dark:hover:bg-gray-800"
              >
                <Plus class="size-3 @sm:size-3.5" />
                Add to plan as a task
              </button>
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

            <button
              type="button"
              onclick={startEditing}
              disabled={actioning}
              class="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 @sm:text-xs dark:hover:bg-gray-800"
            >
              <Pencil class="size-3 @sm:size-3.5" />
              Edit
            </button>

            <button
              type="button"
              onclick={() => onDelete(issue)}
              disabled={actioning}
              class="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 @sm:text-xs dark:hover:bg-gray-800"
            >
              <Trash class="size-3 @sm:size-3.5" />
              Delete issue
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</li>
