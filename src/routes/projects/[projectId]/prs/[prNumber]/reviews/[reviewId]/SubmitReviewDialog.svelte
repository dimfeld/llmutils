<script lang="ts">
  import { untrack } from 'svelte';
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';

  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import {
    getSubmissionPartition,
    submitReviewToGitHub,
  } from '$lib/remote/pr_review_submission.remote.js';
  import type { ReviewIssueRow } from '$tim/db/review.js';
  import { extractRemoteErrorMessage } from './remote_error.js';

  type SubmitEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

  interface SubmitResult {
    submissionId: number;
    githubReviewId: number | null;
    githubReviewUrl: string | null;
    inlineCount: number;
    appendedCount: number;
    issueIds: number[];
  }

  interface Props {
    open: boolean;
    reviewId: number;
    reviewedSha: string | null;
    currentHeadSha: string | null;
    issues: ReviewIssueRow[];
    onClose: () => void;
    onSubmitted: (result: SubmitResult) => void;
  }

  let { open, reviewId, reviewedSha, currentHeadSha, issues, onClose, onSubmitted }: Props =
    $props();

  // Submittable: not resolved AND not already submitted
  let submittableIssues = $derived(
    issues.filter((i) => i.resolved === 0 && i.submittedInPrReviewId == null)
  );

  // Default selection = all submittable. Track as a Set keyed on issue id.
  let selectedIds = $state<Set<number>>(untrack(() => new Set(submittableIssues.map((i) => i.id))));

  let event = $state<SubmitEvent>('COMMENT');
  let body = $state('');

  type Step = 'compose' | 'preview' | 'submitting' | 'result' | 'error';
  let step = $state<Step>('compose');
  let errorMessage = $state<string | null>(null);
  // When GitHub submission succeeded but local DB persistence failed, the review already
  // exists remotely and Retry would duplicate it. We surface the GitHub URL instead and
  // hide the Retry button.
  let persistenceFailed = $state(false);
  let persistenceGitHubUrl = $state<string | null>(null);

  type PartitionPreview = Awaited<ReturnType<typeof getSubmissionPartition>>;
  let partition = $state<PartitionPreview | null>(null);
  let result = $state<SubmitResult | null>(null);

  let commitSha = $derived(reviewedSha ?? currentHeadSha ?? '');
  let fallbackCommitSha = $derived(
    reviewedSha != null && currentHeadSha != null && currentHeadSha !== reviewedSha
      ? currentHeadSha
      : undefined
  );
  let hasStaleSha = $derived(
    currentHeadSha != null && reviewedSha != null && currentHeadSha !== reviewedSha
  );

  function shortSha(sha: string | null | undefined): string {
    return sha ? sha.slice(0, 7) : '';
  }

  function toggleIssue(id: number, checked: boolean) {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    selectedIds = next;
  }

  function selectedIssueIds(): number[] {
    return submittableIssues.filter((i) => selectedIds.has(i.id)).map((i) => i.id);
  }

  async function handleContinue(e: Event) {
    e.preventDefault();
    if (!commitSha) {
      errorMessage = 'No commit SHA available for this review.';
      return;
    }
    errorMessage = null;
    const issueIds = selectedIssueIds();
    try {
      const preview = await getSubmissionPartition({
        reviewId,
        issueIds,
        commitSha,
        fallbackCommitSha,
      });
      partition = preview;
      step = 'preview';
    } catch (err) {
      errorMessage = extractRemoteErrorMessage(err);
    }
  }

  async function handleSubmit() {
    if (!commitSha) {
      errorMessage = 'No commit SHA available for this review.';
      return;
    }
    errorMessage = null;
    step = 'submitting';
    const issueIds = selectedIssueIds();
    try {
      const submission = await submitReviewToGitHub({
        reviewId,
        event,
        body,
        issueIds,
        commitSha,
        fallbackCommitSha,
      });
      result = {
        submissionId: submission.submissionId,
        githubReviewId: submission.githubReviewId,
        githubReviewUrl: submission.githubReviewUrl,
        inlineCount: submission.inlineCount,
        appendedCount: submission.appendedCount,
        issueIds,
      };
      onSubmitted(result);
      step = 'result';
    } catch (err) {
      // SvelteKit rejects remote function calls with the error body directly.
      const body =
        err && typeof err === 'object' && 'body' in err ? (err as { body: unknown }).body : err;
      if (body && typeof body === 'object') {
        const b = body as {
          kind?: unknown;
          message?: unknown;
          githubReviewUrl?: unknown;
        };
        if (b.kind === 'persistence-failed') {
          persistenceFailed = true;
          persistenceGitHubUrl = typeof b.githubReviewUrl === 'string' ? b.githubReviewUrl : null;
          errorMessage = typeof b.message === 'string' ? b.message : String(body);
          step = 'error';
          return;
        }
      }
      errorMessage = extractRemoteErrorMessage(err);
      step = 'error';
    }
  }

  function handleBack() {
    step = 'compose';
  }

  function handleRetry() {
    step = 'preview';
    errorMessage = null;
  }

  function handleClose() {
    if (step === 'submitting') return;
    onClose();
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) handleClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') handleClose();
  }

  let truncate = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="submit-review-title"
    onclick={handleBackdrop}
    onkeydown={handleKeydown}
    tabindex="-1"
  >
    <div
      class="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
      role="document"
    >
      <div class="border-b border-border p-4">
        <h2 id="submit-review-title" class="text-base font-semibold text-foreground">
          Submit review to GitHub
        </h2>
      </div>

      {#if step === 'compose'}
        <form class="flex flex-1 flex-col overflow-hidden" onsubmit={handleContinue}>
          <div class="flex-1 space-y-4 overflow-y-auto p-4">
            {#if hasStaleSha}
              <div
                class="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
              >
                <AlertTriangle class="mt-0.5 size-4 shrink-0" />
                <span>
                  The PR's HEAD has moved since this review was generated. Comments will be anchored
                  to the reviewed SHA (<span class="font-mono">{shortSha(reviewedSha)}</span>). Any
                  issues whose lines no longer match the diff will be appended to the review body.
                </span>
              </div>
            {/if}

            <fieldset class="space-y-2">
              <legend class="text-xs font-medium text-foreground">Status</legend>
              <div class="flex flex-wrap gap-3 text-sm">
                {#each ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as opt (opt)}
                  <label class="inline-flex cursor-pointer items-center gap-1.5">
                    <input
                      type="radio"
                      name="submit-review-event"
                      value={opt}
                      checked={event === opt}
                      onchange={() => (event = opt as SubmitEvent)}
                    />
                    <span>{opt.replaceAll('_', ' ')}</span>
                  </label>
                {/each}
              </div>
            </fieldset>

            <div class="space-y-1">
              <Label for="submit-review-body" class="text-xs text-muted-foreground">Body</Label>
              <Textarea
                id="submit-review-body"
                bind:value={body}
                class="min-h-24 text-xs"
                placeholder="Optional review body…"
              />
            </div>

            <div class="space-y-1">
              <p class="text-xs font-medium text-foreground">
                Issues to include
                <span class="ml-1 font-normal text-muted-foreground">
                  ({selectedIds.size} of {submittableIssues.length} selected)
                </span>
              </p>
              {#if submittableIssues.length === 0}
                <p class="text-xs text-muted-foreground">
                  No submittable issues. You can still submit a review with a body only.
                </p>
              {:else}
                <ul
                  class="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-xs"
                >
                  {#each submittableIssues as issue (issue.id)}
                    <li>
                      <label class="flex cursor-pointer items-start gap-2">
                        <input
                          type="checkbox"
                          class="mt-0.5"
                          checked={selectedIds.has(issue.id)}
                          onchange={(e) =>
                            toggleIssue(issue.id, (e.currentTarget as HTMLInputElement).checked)}
                        />
                        <span class="min-w-0 flex-1">
                          {#if issue.file}
                            <span class="font-mono text-[10px] text-muted-foreground">
                              {issue.file}{issue.line ? `:${issue.line}` : ''}
                            </span>
                          {/if}
                          <span class="block text-foreground">{truncate(issue.content)}</span>
                        </span>
                      </label>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>

            {#if errorMessage}
              <p class="text-xs text-red-600 dark:text-red-400">{errorMessage}</p>
            {/if}
          </div>

          <div class="flex items-center justify-end gap-2 border-t border-border p-4">
            <Button type="button" size="sm" variant="outline" onclick={handleClose}>Cancel</Button>
            <Button type="submit" size="sm">Continue</Button>
          </div>
        </form>
      {:else if step === 'preview' && partition}
        <div class="flex-1 space-y-4 overflow-y-auto p-4">
          {#if partition.fellBackToHead}
            <div
              class="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
            >
              <AlertTriangle class="mt-[2px] size-4 shrink-0" />
              <span>
                The reviewed commit (<code>{shortSha(commitSha)}</code>) is no longer on GitHub, so
                the diff was fetched against the current PR head (<code
                  >{shortSha(partition.usedCommitSha)}</code
                >). Some inline anchors may have drifted.
              </span>
            </div>
          {/if}
          <p class="text-xs text-muted-foreground">
            <span class="font-medium text-foreground">{partition.inlineable.length}</span>
            {partition.inlineable.length === 1 ? 'comment' : 'comments'} will be posted inline,
            <span class="font-medium text-foreground">{partition.appendToBody.length}</span>
            will be appended to the body because their lines aren't in the diff or are unanchored.
          </p>

          {#if partition.inlineable.length > 0}
            <div>
              <h3 class="mb-1 text-xs font-semibold text-foreground">Inline comments</h3>
              <ul class="space-y-1 rounded-md border border-border p-2 text-xs">
                {#each partition.inlineable as issue (issue.id)}
                  <li>
                    <span class="font-mono text-[10px] text-muted-foreground">
                      {issue.file}{issue.line ? `:${issue.line}` : ''}
                    </span>
                    <span class="block text-foreground">{truncate(issue.content)}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

          {#if partition.appendToBody.length > 0}
            <div>
              <h3 class="mb-1 text-xs font-semibold text-foreground">Appended to body</h3>
              <ul class="space-y-1 rounded-md border border-border p-2 text-xs">
                {#each partition.appendToBody as issue (issue.id)}
                  <li>
                    {#if issue.file}
                      <span class="font-mono text-[10px] text-muted-foreground">
                        {issue.file}{issue.line ? `:${issue.line}` : ''}
                      </span>
                    {/if}
                    <span class="block text-foreground">{truncate(issue.content)}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

          {#if errorMessage}
            <p class="text-xs text-red-600 dark:text-red-400">{errorMessage}</p>
          {/if}
        </div>
        <div class="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button type="button" size="sm" variant="outline" onclick={handleBack}>Back</Button>
          <Button type="button" size="sm" onclick={handleSubmit}>Submit to GitHub</Button>
        </div>
      {:else if step === 'submitting'}
        <div class="flex-1 p-6 text-center text-sm text-muted-foreground">
          Submitting review to GitHub…
        </div>
      {:else if step === 'result' && result}
        <div class="flex-1 space-y-3 p-4">
          <p class="text-sm text-foreground">Review submitted successfully.</p>
          <p class="text-xs text-muted-foreground">
            {result.inlineCount} inline {result.inlineCount === 1 ? 'comment' : 'comments'},
            {result.appendedCount} appended to body.
          </p>
          {#if result.githubReviewUrl}
            <p class="text-xs">
              <a
                class="text-blue-600 underline hover:text-blue-700 dark:text-blue-400"
                href={result.githubReviewUrl}
                target="_blank"
                rel="noreferrer"
              >
                View review on GitHub
              </a>
            </p>
          {/if}
        </div>
        <div class="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button type="button" size="sm" onclick={handleClose}>Close</Button>
        </div>
      {:else if step === 'error'}
        <div class="flex-1 space-y-3 p-4">
          <p class="text-sm text-red-600 dark:text-red-400">
            {errorMessage ?? 'Submission failed.'}
          </p>
          {#if persistenceFailed && persistenceGitHubUrl}
            <p class="text-xs">
              <a
                class="text-blue-600 underline hover:text-blue-700 dark:text-blue-400"
                href={persistenceGitHubUrl}
                target="_blank"
                rel="noreferrer"
              >
                View review on GitHub
              </a>
            </p>
          {/if}
        </div>
        <div class="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button type="button" size="sm" variant="outline" onclick={handleClose}>Close</Button>
          {#if !persistenceFailed}
            <Button type="button" size="sm" onclick={handleRetry}>Retry</Button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}
