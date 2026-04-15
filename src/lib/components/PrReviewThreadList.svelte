<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import type { PrReviewThreadDetail } from '$tim/db/pr_status.js';
  import {
    convertThreadToTask,
    replyToThread,
    resolveThread,
  } from '$lib/remote/review_thread_actions.remote.js';
  import { normalizeGitHubUsername } from '$common/github/username.js';
  import { formatReviewCommentForClipboard } from '$lib/utils/pr_display.js';
  import { getReviewThreadHunkWindow } from '$lib/utils/review_hunk.js';
  import { renderMarkdown } from '$lib/utils/markdown_parser.js';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import Diff from './Diff.svelte';
  import CopyButton from './CopyButton.svelte';

  let {
    threads,
    prUrl,
    planUuid,
    currentUsername = null,
    expandMode = 'default',
  }: {
    threads: PrReviewThreadDetail[];
    prUrl: string;
    planUuid?: string;
    currentUsername?: string | null;
    expandMode?: 'default' | 'expanded' | 'collapsed' | 'mine';
  } = $props();

  let threadExpandModeOverride = $state<'default' | 'expanded' | 'collapsed' | 'mine'>('default');
  let effectiveThreadExpandMode = $derived(
    threadExpandModeOverride === 'default' ? expandMode : threadExpandModeOverride
  );

  let sortedThreads = $derived(
    [...threads].sort((a, b) => {
      const pathCmp = a.thread.path.localeCompare(b.thread.path);
      if (pathCmp !== 0) return pathCmp;
      return (displayLine(a) ?? 0) - (displayLine(b) ?? 0);
    })
  );

  function displayLine(thread: PrReviewThreadDetail): number | null {
    const t = thread.thread;
    return t.line ?? t.original_line ?? t.start_line ?? t.original_start_line;
  }

  function githubLink(thread: PrReviewThreadDetail): string {
    const databaseId = thread.comments.find((c) => c.database_id != null)?.database_id;
    if (databaseId) {
      return `${prUrl}#discussion_r${databaseId}`;
    }
    return prUrl;
  }

  function locationLabel(thread: PrReviewThreadDetail): string {
    const line = displayLine(thread);
    return line != null ? `${thread.thread.path}:${line}` : thread.thread.path;
  }

  function threadDiffHunk(thread: PrReviewThreadDetail): string | null {
    return thread.comments.find((c) => c.diff_hunk != null)?.diff_hunk ?? null;
  }

  function threadHasCurrentUserComment(thread: PrReviewThreadDetail): boolean {
    if (!currentUsername) {
      return false;
    }

    const normalizedCurrentUsername = normalizeGitHubUsername(currentUsername);
    return thread.comments.some(
      (comment) => normalizeGitHubUsername(comment.author) === normalizedCurrentUsername
    );
  }

  function threadCommentBadgeLabel(thread: PrReviewThreadDetail): string | null {
    if (!threadHasCurrentUserComment(thread)) {
      return null;
    }

    const firstComment = thread.comments[0];
    if (
      firstComment &&
      firstComment.author &&
      currentUsername &&
      normalizeGitHubUsername(firstComment.author) === normalizeGitHubUsername(currentUsername)
    ) {
      return 'Your Thread';
    }

    return 'You commented';
  }

  function isThreadExpanded(thread: PrReviewThreadDetail): boolean {
    const isResolved = !!thread.thread.is_resolved;
    if (effectiveThreadExpandMode === 'expanded') {
      return true;
    }

    if (effectiveThreadExpandMode === 'collapsed') {
      return false;
    }

    if (effectiveThreadExpandMode === 'mine') {
      return threadHasCurrentUserComment(thread);
    }

    return !isResolved;
  }

  let threadActionSubmitting = $state<{
    threadId: string;
    action: 'convert' | 'resolve' | 'reply';
  } | null>(null);
  let replyingToThreadId = $state<string | null>(null);
  let replyBody = $state('');
  let expandedHunks = $state<Record<number, boolean>>({});

  function isSubmittingThread(threadId: string, action?: 'convert' | 'resolve' | 'reply'): boolean {
    if (threadActionSubmitting?.threadId !== threadId) {
      return false;
    }

    return action ? threadActionSubmitting.action === action : true;
  }

  function commentCopyText(
    comment: PrReviewThreadDetail['comments'][number],
    thread: PrReviewThreadDetail,
    includeDiff: boolean
  ): string {
    return formatReviewCommentForClipboard(
      thread.thread.path,
      displayLine(thread),
      comment.author,
      !!thread.thread.is_resolved,
      comment.body,
      comment.diff_hunk,
      includeDiff
    );
  }

  async function handleConvertToTask(thread: PrReviewThreadDetail) {
    if (threadActionSubmitting !== null) {
      return;
    }

    if (!planUuid) {
      toast.error('Cannot convert thread to task without a plan context');
      return;
    }

    threadActionSubmitting = { threadId: thread.thread.thread_id, action: 'convert' };
    try {
      await convertThreadToTask({
        planUuid,
        prStatusId: thread.thread.pr_status_id,
        threadId: thread.thread.thread_id,
      });
      await invalidateAll();
      toast.success('Thread converted to task');
    } catch (err) {
      toast.error(`Failed to convert thread to task: ${(err as Error).message}`);
    } finally {
      threadActionSubmitting = null;
    }
  }

  async function handleResolveThread(thread: PrReviewThreadDetail) {
    if (threadActionSubmitting !== null) {
      return;
    }

    threadActionSubmitting = { threadId: thread.thread.thread_id, action: 'resolve' };
    try {
      const result = await resolveThread({
        prStatusId: thread.thread.pr_status_id,
        threadId: thread.thread.thread_id,
      });
      if (!result.success) {
        toast.error('Failed to resolve thread');
        return;
      }
      if (replyingToThreadId === thread.thread.thread_id) {
        replyingToThreadId = null;
        replyBody = '';
      }
      await invalidateAll();
      toast.success('Thread resolved');
    } catch (err) {
      toast.error(`Failed to resolve thread: ${(err as Error).message}`);
    } finally {
      threadActionSubmitting = null;
    }
  }

  function openReplyForm(threadId: string) {
    if (threadActionSubmitting !== null) {
      return;
    }

    if (replyingToThreadId === threadId) {
      replyingToThreadId = null;
      replyBody = '';
      return;
    }

    replyingToThreadId = threadId;
    replyBody = '';
  }

  function cancelReply() {
    replyingToThreadId = null;
    replyBody = '';
  }

  async function handleReplyToThread(thread: PrReviewThreadDetail) {
    if (threadActionSubmitting !== null) {
      return;
    }

    const body = replyBody.trim();
    if (!body) {
      toast.error('Reply cannot be empty');
      return;
    }

    threadActionSubmitting = { threadId: thread.thread.thread_id, action: 'reply' };
    try {
      const result = await replyToThread({
        prStatusId: thread.thread.pr_status_id,
        threadId: thread.thread.thread_id,
        body,
      });
      if (!result.success) {
        toast.error('Failed to send reply');
        return;
      }
      await invalidateAll();
      toast.success('Reply sent');
      cancelReply();
    } catch (err) {
      toast.error(`Failed to send reply: ${(err as Error).message}`);
    } finally {
      threadActionSubmitting = null;
    }
  }

  function setThreadExpandMode(mode: 'default' | 'expanded' | 'collapsed' | 'mine') {
    threadExpandModeOverride = mode;
  }

  function expandModeButtonClass(isActive: boolean): string {
    return `rounded border px-2 py-1 text-xs font-medium transition-colors ${
      isActive
        ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-300'
        : 'border-gray-300 text-muted-foreground hover:bg-gray-100 hover:text-foreground dark:border-gray-600 dark:hover:bg-gray-800'
    }`;
  }

  function renderCommentBody(body: string | null): string {
    return renderMarkdown(body ?? '');
  }

  function isHunkExpanded(threadId: number): boolean {
    return !!expandedHunks[threadId];
  }

  function toggleHunk(threadId: number): void {
    expandedHunks[threadId] = !expandedHunks[threadId];
  }
</script>

{#if sortedThreads.length > 0}
  <div class="mb-2 flex flex-wrap items-center gap-2">
    <button
      type="button"
      class={expandModeButtonClass(effectiveThreadExpandMode === 'expanded')}
      aria-pressed={effectiveThreadExpandMode === 'expanded'}
      onclick={() => setThreadExpandMode('expanded')}
    >
      Expand all
    </button>
    <button
      type="button"
      class={expandModeButtonClass(effectiveThreadExpandMode === 'collapsed')}
      aria-pressed={effectiveThreadExpandMode === 'collapsed'}
      onclick={() => setThreadExpandMode('collapsed')}
    >
      Collapse all
    </button>
    <button
      type="button"
      class={expandModeButtonClass(effectiveThreadExpandMode === 'mine')}
      aria-pressed={effectiveThreadExpandMode === 'mine'}
      onclick={() => setThreadExpandMode('mine')}
      disabled={!currentUsername}
      title={currentUsername
        ? 'Expand only threads where you commented'
        : 'Set a username to use this filter'}
    >
      My comments
    </button>
  </div>
{/if}

{#snippet threadControls(thread: PrReviewThreadDetail, isResolved: boolean)}
  <span class="ml-auto text-muted-foreground">
    {thread.comments.length} comment{thread.comments.length === 1 ? '' : 's'}
  </span>
  {#if !isResolved}
    {#if planUuid}
      <button
        class="rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
        onclick={async (event) => {
          event.preventDefault();
          event.stopPropagation();
          await handleConvertToTask(thread);
        }}
        disabled={threadActionSubmitting !== null}
        type="button"
      >
        {isSubmittingThread(thread.thread.thread_id, 'convert')
          ? 'Converting...'
          : 'Convert to Task'}
      </button>
    {/if}
    <button
      class="rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
      onclick={async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await handleResolveThread(thread);
      }}
      disabled={threadActionSubmitting !== null}
      type="button"
    >
      {isSubmittingThread(thread.thread.thread_id, 'resolve') ? 'Resolving...' : 'Resolve'}
    </button>
    <button
      class="rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
      onclick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openReplyForm(thread.thread.thread_id);
      }}
      disabled={threadActionSubmitting !== null}
      type="button"
    >
      {replyingToThreadId === thread.thread.thread_id ? 'Cancel Reply' : 'Reply'}
    </button>
  {/if}
{/snippet}

<div class="space-y-3">
  {#each sortedThreads as thread (thread.thread.id)}
    {@const isResolved = !!thread.thread.is_resolved}
    {@const isOutdated = !!thread.thread.is_outdated}
    {@const diffHunk = threadDiffHunk(thread)}
    {@const diffHunkLineCount = Math.max(0, diffHunk ? diffHunk.split('\n').length - 1 : 0)}
    {@const hunkContextLines = diffHunkLineCount > 20 ? 10 : Number.MAX_SAFE_INTEGER}
    {@const hunkWindow = diffHunk
      ? getReviewThreadHunkWindow(thread.thread, diffHunk, hunkContextLines)
      : { hunk: null, isTruncated: false }}
    {@const commentBadgeLabel = threadCommentBadgeLabel(thread)}
    {@const isExpanded = isThreadExpanded(thread)}
    <details open={isExpanded} class="rounded border border-gray-200 dark:border-gray-700">
      <summary
        class="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs hover:bg-gray-50 dark:hover:bg-gray-800/50"
      >
        <a
          href={githubLink(thread)}
          target="_blank"
          rel="noopener noreferrer"
          class="font-mono text-blue-600 hover:underline dark:text-blue-400"
          onclick={(e) => e.stopPropagation()}
        >
          {locationLabel(thread)}
        </a>
        <CopyButton
          text={thread.thread.path}
          mode="icon"
          iconClass="size-3"
          className="rounded p-0.5 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800"
          title="Copy file path"
          ariaLabel="Copy file path"
          onCopied={() => toast.success('File path copied')}
          onCopyError={(message) => toast.error(`Failed to copy file path: ${message}`)}
        />
        <span class="flex items-center gap-1">
          {#if isResolved}
            <span
              class="inline-flex items-center rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900/30 dark:text-green-300"
            >
              Resolved
            </span>
          {/if}
          {#if isOutdated}
            <span
              class="inline-flex items-center rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400"
            >
              Outdated
            </span>
          {/if}
          {#if commentBadgeLabel}
            <span
              class="inline-flex items-center rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
            >
              {commentBadgeLabel}
            </span>
          {/if}
        </span>
        {@render threadControls(thread, isResolved)}
      </summary>

      <div class="border-t border-gray-200 dark:border-gray-700">
        {#if diffHunk}
          {#if hunkWindow.isTruncated}
            <div
              class="border-b border-gray-200 px-3 py-2 text-xs text-muted-foreground dark:border-gray-700"
            >
              <div class="flex items-center gap-2">
                <span>
                  Showing {isHunkExpanded(thread.thread.id) ? 'full hunk' : '10 lines of context'}
                </span>
                <button
                  class="ml-auto rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
                  onclick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleHunk(thread.thread.id);
                  }}
                  type="button"
                >
                  {isHunkExpanded(thread.thread.id) ? 'Show 10-line context' : 'Show full hunk'}
                </button>
              </div>
            </div>
          {/if}
          <div style="--diffs-font-size: 12px; --diffs-line-height: 1.5;">
            <Diff
              patch={isHunkExpanded(thread.thread.id) || !hunkWindow.isTruncated
                ? diffHunk
                : (hunkWindow.hunk ?? diffHunk)}
              filename={thread.thread.path}
              disableFileHeader
              hunkSeparators="simple"
            />
          </div>
        {/if}

        <div class="divide-y divide-gray-100 dark:divide-gray-800">
          {#each thread.comments as comment (comment.id)}
            <div class="group relative px-3 py-2">
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <span class="font-medium text-foreground">{comment.author ?? 'Unknown'}</span>
                {#if comment.created_at}
                  <span title={comment.created_at}>{formatRelativeTime(comment.created_at)}</span>
                {/if}
                <CopyButton
                  text={commentCopyText(comment, thread, false)}
                  mode="text"
                  label="Copy"
                  copiedLabel="Copied!"
                  failedLabel="Failed"
                  className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800"
                  title="Copy comment"
                  disabled={threadActionSubmitting !== null}
                  ariaLabel="Copy comment"
                />
                <CopyButton
                  text={commentCopyText(comment, thread, true)}
                  mode="text"
                  label="Copy with Diff"
                  copiedLabel="Copied!"
                  failedLabel="Failed"
                  className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800"
                  title="Copy comment with file context and diff"
                  disabled={threadActionSubmitting !== null}
                  ariaLabel="Copy comment with file context and diff"
                />
              </div>
              <div class="plan-rendered-content mt-1 text-sm text-foreground">
                {@html renderCommentBody(comment.body)}
              </div>
            </div>
          {/each}
        </div>

        {#if !isResolved && replyingToThreadId === thread.thread.thread_id}
          <div class="border-t border-gray-200 px-3 py-3 dark:border-gray-700">
            <label
              class="mb-2 block text-xs font-medium text-foreground"
              for={`reply-${thread.thread.id}`}
            >
              Reply to review thread
            </label>
            <textarea
              id={`reply-${thread.thread.id}`}
              class="min-h-24 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-foreground focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900"
              bind:value={replyBody}
              disabled={threadActionSubmitting !== null}
            ></textarea>
            <div class="mt-2 flex items-center justify-end gap-2">
              <button
                class="rounded border border-gray-300 px-3 py-1.5 text-xs text-muted-foreground hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800"
                onclick={cancelReply}
                disabled={threadActionSubmitting !== null}
                type="button"
              >
                Cancel
              </button>
              <button
                class="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                onclick={async () => {
                  await handleReplyToThread(thread);
                }}
                disabled={threadActionSubmitting !== null || replyBody.trim().length === 0}
                type="button"
              >
                {isSubmittingThread(thread.thread.thread_id, 'reply') ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        {/if}

        <div
          class="flex items-center gap-2 border-t border-gray-200 px-3 py-2 text-xs dark:border-gray-700"
        >
          {@render threadControls(thread, isResolved)}
        </div>
      </div>
    </details>
  {/each}
</div>
