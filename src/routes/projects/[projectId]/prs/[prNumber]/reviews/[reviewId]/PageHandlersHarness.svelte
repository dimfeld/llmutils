<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { ReviewIssueRow, ReviewCategory } from '$tim/db/review.js';
  import ReviewIssueCard from './ReviewIssueCard.svelte';
  import { createAnnotationClickHandler, createSaveEditHandler } from './page_handlers.js';
  import type { ReviewIssuePatch } from './review_issue_editor_utils.js';

  interface HarnessApi {
    handleAnnotationClick: (issueId: number) => void;
    handleSaveEdit: (issue: ReviewIssueRow, patch: ReviewIssuePatch) => Promise<void>;
    getIssues: () => ReviewIssueRow[];
    getHighlightedIssueId: () => number | null;
    getError: () => string | null;
  }

  interface Props {
    initialIssues: ReviewIssueRow[];
    updateRemote: (args: { issueId: number; patch: ReviewIssuePatch }) => Promise<ReviewIssueRow>;
    onReady?: (api: HarnessApi) => void;
  }

  let { initialIssues, updateRemote, onReady }: Props = $props();

  let issues = $state(untrack(() => initialIssues.map((i) => ({ ...i }))));
  let highlightedIssueId = $state<number | null>(null);
  let errorMessage = $state<string | null>(null);

  const annotationClick = createAnnotationClickHandler({
    setHighlightedIssueId: (id) => {
      highlightedIssueId = id;
    },
  });

  const handleSaveEdit = createSaveEditHandler({
    getIssues: () => issues,
    setIssues: (next) => {
      issues = next;
    },
    setError: (m) => {
      errorMessage = m;
    },
    updateRemote: (args) => updateRemote(args),
  });

  const categoryBadgeClass = (_c: ReviewCategory) => 'bg-gray-100';
  const issueLocationLabel = (i: ReviewIssueRow) => (i.file ? `${i.file}:${i.line}` : null);
  const formatCategory = (c: ReviewCategory) => c.charAt(0).toUpperCase() + c.slice(1);

  const noop = () => {};

  onMount(() => {
    onReady?.({
      handleAnnotationClick: annotationClick.handleAnnotationClick,
      handleSaveEdit,
      getIssues: () => issues,
      getHighlightedIssueId: () => highlightedIssueId,
      getError: () => errorMessage,
    });
  });
</script>

<details open>
  <summary>group</summary>
  <ul>
    {#each issues as issue (issue.id)}
      <ReviewIssueCard
        {issue}
        actioning={false}
        linkedPlanUuid={null}
        rootId="review-issue-{issue.id}"
        highlighted={highlightedIssueId === issue.id}
        {categoryBadgeClass}
        {issueLocationLabel}
        {formatCategory}
        onToggleResolved={noop}
        onDelete={noop}
        onAddToPlan={noop}
        onSaveEdit={handleSaveEdit}
      />
    {/each}
  </ul>
</details>
