<script lang="ts">
  import { untrack } from 'svelte';

  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { createReviewIssue } from '$lib/remote/pr_review_submission.remote.js';
  import type { ReviewIssueRow, ReviewIssueSide } from '$tim/db/review.js';

  import { buildCreateReviewIssueInput } from './new_issue_modal_utils.js';
  import { extractRemoteErrorMessage } from './remote_error.js';

  interface Props {
    open: boolean;
    reviewId: number;
    file: string;
    startLine: number;
    endLine: number;
    side: ReviewIssueSide;
    onSaved: (newIssue: ReviewIssueRow) => void;
    onClose: () => void;
  }

  let { open, reviewId, file, startLine, endLine, side, onSaved, onClose }: Props = $props();

  let content = $state(untrack(() => ''));
  let suggestion = $state(untrack(() => ''));
  let saving = $state(false);
  let errorMessage = $state<string | null>(null);

  let canSave = $derived(content.trim().length > 0 && !saving);

  let rangeLabel = $derived(startLine === endLine ? String(startLine) : `${startLine}–${endLine}`);

  async function handleSubmit(event: Event) {
    event.preventDefault();
    if (!canSave) return;
    errorMessage = null;
    saving = true;

    try {
      const created = await createReviewIssue(
        buildCreateReviewIssueInput({
          reviewId,
          file,
          startLine,
          endLine,
          side,
          content,
          suggestion,
        })
      );
      onSaved(created);
      content = '';
      suggestion = '';
      onClose();
    } catch (err) {
      errorMessage = extractRemoteErrorMessage(err);
    } finally {
      saving = false;
    }
  }

  function handleCancel() {
    if (saving) return;
    content = '';
    suggestion = '';
    errorMessage = null;
    onClose();
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      handleCancel();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      handleCancel();
    }
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="new-review-issue-title"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
    tabindex="-1"
  >
    <div
      class="w-full max-w-lg rounded-lg border border-border bg-background shadow-lg"
      role="document"
    >
      <form class="space-y-3 p-4" onsubmit={handleSubmit}>
        <div>
          <h2 id="new-review-issue-title" class="text-sm font-semibold text-foreground">
            New review issue
          </h2>
          <p class="mt-0.5 text-xs text-muted-foreground">
            <span class="font-mono">{file}:{rangeLabel}</span>
            <span class="ml-1">({side})</span>
          </p>
        </div>

        <div class="space-y-1">
          <Label for="new-issue-content" class="text-[10px] text-muted-foreground">
            Issue content
          </Label>
          <Textarea
            id="new-issue-content"
            bind:value={content}
            disabled={saving}
            required
            class="min-h-24 text-xs"
            placeholder="Describe the issue…"
          />
        </div>

        <div class="space-y-1">
          <Label for="new-issue-suggestion" class="text-[10px] text-muted-foreground">
            Suggestion (optional)
          </Label>
          <Textarea
            id="new-issue-suggestion"
            bind:value={suggestion}
            disabled={saving}
            class="min-h-20 text-xs"
            placeholder="Optional suggestion…"
          />
        </div>

        {#if errorMessage}
          <p class="text-[11px] text-red-600 dark:text-red-400">{errorMessage}</p>
        {/if}

        <div class="flex items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onclick={handleCancel}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canSave}>
            {saving ? 'Saving…' : 'Save issue'}
          </Button>
        </div>
      </form>
    </div>
  </div>
{/if}
