<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import type { PrReviewThreadDetail } from '$tim/db/pr_status.js';
  import { convertThreadToTask } from '$lib/remote/review_thread_actions.remote.js';
  import { formatReviewCommentForClipboard } from '$lib/utils/pr_display.js';
  import { formatRelativeTime } from '$lib/utils/time.js';

  let {
    threads,
    prUrl,
    planUuid,
  }: { threads: PrReviewThreadDetail[]; prUrl: string; planUuid: string } = $props();

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
    return line ? `${thread.thread.path}:${line}` : thread.thread.path;
  }

  function threadDiffHunk(thread: PrReviewThreadDetail): string | null {
    return thread.comments.find((c) => c.diff_hunk != null)?.diff_hunk ?? null;
  }

  let copyFeedback = $state<{ id: number; status: 'copied' | 'failed' } | null>(null);
  let threadActionSubmitting = $state<string | null>(null);

  async function copyComment(
    comment: PrReviewThreadDetail['comments'][number],
    thread: PrReviewThreadDetail
  ) {
    const text = formatReviewCommentForClipboard(
      thread.thread.path,
      displayLine(thread),
      comment.author,
      !!thread.thread.is_resolved,
      comment.body,
      comment.diff_hunk
    );
    let status: 'copied' | 'failed';
    try {
      await navigator.clipboard.writeText(text);
      status = 'copied';
    } catch {
      status = 'failed';
    }
    copyFeedback = { id: comment.id, status };
    setTimeout(() => {
      if (copyFeedback?.id === comment.id) copyFeedback = null;
    }, 2000);
  }

  async function handleConvertToTask(thread: PrReviewThreadDetail) {
    if (threadActionSubmitting !== null) {
      return;
    }

    threadActionSubmitting = thread.thread.thread_id;
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
</script>

<div class="space-y-3">
  {#each sortedThreads as thread (thread.thread.id)}
    {@const isResolved = !!thread.thread.is_resolved}
    {@const isOutdated = !!thread.thread.is_outdated}
    {@const diffHunk = threadDiffHunk(thread)}
    <details open={!isResolved} class="rounded border border-gray-200 dark:border-gray-700">
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
        </span>
        <span class="ml-auto text-muted-foreground">
          {thread.comments.length} comment{thread.comments.length === 1 ? '' : 's'}
        </span>
        {#if !isResolved}
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
            {threadActionSubmitting === thread.thread.thread_id
              ? 'Converting...'
              : 'Convert to Task'}
          </button>
        {/if}
      </summary>

      <div class="border-t border-gray-200 dark:border-gray-700">
        {#if diffHunk}
          <pre
            class="overflow-x-auto border-b border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs leading-relaxed text-gray-700 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-300">{diffHunk}</pre>
        {/if}

        <div class="divide-y divide-gray-100 dark:divide-gray-800">
          {#each thread.comments as comment (comment.id)}
            <div class="group relative px-3 py-2">
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <span class="font-medium text-foreground">{comment.author ?? 'Unknown'}</span>
                {#if comment.created_at}
                  <span title={comment.created_at}>{formatRelativeTime(comment.created_at)}</span>
                {/if}
                <button
                  class="ml-auto rounded px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-gray-100 focus-visible:opacity-100 dark:hover:bg-gray-800"
                  onclick={() => copyComment(comment, thread)}
                  title="Copy comment with file context"
                  disabled={threadActionSubmitting !== null}
                >
                  {#if copyFeedback?.id === comment.id}
                    {copyFeedback.status === 'copied' ? 'Copied!' : 'Failed'}
                  {:else}
                    Copy
                  {/if}
                </button>
              </div>
              <div class="mt-1 text-sm whitespace-pre-wrap text-foreground">
                {comment.body ?? ''}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </details>
  {/each}
</div>
