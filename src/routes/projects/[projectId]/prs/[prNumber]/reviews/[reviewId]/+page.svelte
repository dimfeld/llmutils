<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
  import { toggleReviewIssueResolved } from '$lib/remote/pr_reviews.remote.js';
  import {
    addReviewIssueToPlanTask,
    deleteReviewIssue,
  } from '$lib/remote/review_issue_actions.remote.js';
  import MarkdownContent from '$lib/components/MarkdownContent.svelte';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import { Splitpanes, Pane } from 'svelte-splitpanes';
  import type { ReviewIssueRow, ReviewSeverity, ReviewCategory } from '$tim/db/review.js';
  import ReviewIssueCard from './ReviewIssueCard.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let projectId = $derived(page.params.projectId);
  let prNumber = $derived(page.params.prNumber);

  // Local state for optimistic issue updates
  let issues = $state(data.issues.map((i) => ({ ...i })));
  $effect(() => {
    issues = data.issues.map((i) => ({ ...i }));
  });

  let togglingIssueIds = $state(new Set<number>());
  let issueActionError = $state<string | null>(null);
  let copiedIssueId = $state<number | null>(null);

  const SEVERITY_ORDER: ReviewSeverity[] = ['critical', 'major', 'minor', 'info'];

  let groupedIssues = $derived.by(() => {
    const groups = new Map<ReviewSeverity, ReviewIssueRow[]>();
    for (const severity of SEVERITY_ORDER) {
      groups.set(severity, []);
    }
    for (const issue of issues) {
      groups.get(issue.severity)?.push(issue);
    }
    return groups;
  });

  let hasNewCommits = $derived(
    data.currentHeadSha != null &&
      data.review.reviewed_sha != null &&
      data.currentHeadSha !== data.review.reviewed_sha &&
      data.review.status === 'complete'
  );

  let unresolvedCount = $derived(issues.filter((i) => !i.resolved).length);
  let linkedPlanUuid = $derived(data.linkedPlanUuid);

  function isIssueActioning(issueId: number): boolean {
    return togglingIssueIds.has(issueId);
  }

  function setIssueActioning(issueId: number) {
    togglingIssueIds.add(issueId);
    togglingIssueIds = togglingIssueIds;
  }

  function clearIssueActioning(issueId: number) {
    togglingIssueIds.delete(issueId);
    togglingIssueIds = togglingIssueIds;
  }

  async function handleToggleResolved(issue: ReviewIssueRow) {
    if (isIssueActioning(issue.id)) return;
    issueActionError = null;

    const newResolved = !issue.resolved;
    const local = issues.find((i) => i.id === issue.id);
    if (local) local.resolved = newResolved ? 1 : 0;
    setIssueActioning(issue.id);

    try {
      await toggleReviewIssueResolved({ issueId: issue.id, resolved: newResolved });
    } catch (err) {
      if (local) local.resolved = newResolved ? 0 : 1;
      issueActionError = err instanceof Error ? err.message : String(err);
      await invalidateAll();
    } finally {
      clearIssueActioning(issue.id);
    }
  }

  async function handleDeleteIssue(issue: ReviewIssueRow) {
    if (isIssueActioning(issue.id)) return;
    issueActionError = null;
    setIssueActioning(issue.id);

    try {
      await deleteReviewIssue({ reviewId: data.review.id, issueId: issue.id });
      await invalidateAll();
    } catch (err) {
      issueActionError = err instanceof Error ? err.message : String(err);
    } finally {
      clearIssueActioning(issue.id);
    }
  }

  async function handleAddIssueToPlan(issue: ReviewIssueRow) {
    if (isIssueActioning(issue.id) || !linkedPlanUuid) return;
    issueActionError = null;
    setIssueActioning(issue.id);

    try {
      await addReviewIssueToPlanTask({
        reviewId: data.review.id,
        issueId: issue.id,
        planUuid: linkedPlanUuid,
      });
      await invalidateAll();
    } catch (err) {
      issueActionError = err instanceof Error ? err.message : String(err);
    } finally {
      clearIssueActioning(issue.id);
    }
  }

  function issueLocationLabel(issue: ReviewIssueRow): string | null {
    if (!issue.file) return null;

    const line =
      issue.start_line && issue.line && issue.start_line !== issue.line
        ? `${issue.start_line}–${issue.line}`
        : (issue.line ?? issue.start_line);

    return line ? `${issue.file}:${line}` : issue.file;
  }

  function issueClipboardText(issue: ReviewIssueRow): string {
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

  async function handleCopyIssue(issue: ReviewIssueRow) {
    issueActionError = null;
    try {
      await navigator.clipboard.writeText(issueClipboardText(issue));
      copiedIssueId = issue.id;
      setTimeout(() => {
        if (copiedIssueId === issue.id) {
          copiedIssueId = null;
        }
      }, 1500);
    } catch (err) {
      issueActionError = err instanceof Error ? err.message : String(err);
    }
  }

  function severityBadgeClass(severity: ReviewSeverity): string {
    switch (severity) {
      case 'critical':
        return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
      case 'major':
        return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
      case 'minor':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
      case 'info':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
    }
  }

  function categoryBadgeClass(_category: ReviewCategory): string {
    return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }

  function statusBadgeClass(status: string): string {
    switch (status) {
      case 'complete':
        return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
      case 'in_progress':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
      case 'error':
        return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
      default:
        return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
    }
  }

  function statusLabel(status: string): string {
    switch (status) {
      case 'complete':
        return 'Complete';
      case 'in_progress':
        return 'In Progress';
      case 'error':
        return 'Error';
      default:
        return 'Pending';
    }
  }

  function formatCategory(category: ReviewCategory): string {
    switch (category) {
      case 'security':
        return 'Security';
      case 'performance':
        return 'Performance';
      case 'bug':
        return 'Bug';
      case 'style':
        return 'Style';
      case 'compliance':
        return 'Compliance';
      case 'testing':
        return 'Testing';
      case 'other':
        return 'Other';
    }
  }

  function formatSeverity(severity: ReviewSeverity): string {
    return severity.charAt(0).toUpperCase() + severity.slice(1);
  }

  function shortSha(sha: string | null): string {
    return sha ? sha.slice(0, 7) : '';
  }
</script>

<div
  class="flex h-full flex-col overflow-hidden px-6 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
  aria-label="Review guide detail"
>
  <!-- Top: back link, header, metadata, alerts -->
  <div class="mb-4 shrink-0 space-y-3 pt-6">
    <a
      href="/projects/{projectId}/prs/{prNumber}"
      class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft class="size-3.5" />
      Back to PR #{prNumber}
    </a>

    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <h2 class="text-lg font-semibold text-foreground">Review Guide</h2>
        <div class="mt-0.5 text-sm text-muted-foreground">
          {data.review.branch}
          {#if data.review.base_branch}
            <span class="text-foreground/50"> → {data.review.base_branch}</span>
          {/if}
        </div>
      </div>
      <span
        class="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium {statusBadgeClass(
          data.review.status
        )}"
      >
        {statusLabel(data.review.status)}
      </span>
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span title={data.review.created_at}>
        Generated {formatRelativeTime(data.review.created_at)}
      </span>
      {#if data.review.reviewed_sha}
        <span class="font-mono">SHA: {shortSha(data.review.reviewed_sha)}</span>
      {/if}
      {#if data.review.status === 'complete'}
        <span
          >{issues.length} issue{issues.length === 1 ? '' : 's'} ({unresolvedCount} unresolved)</span
        >
      {/if}
    </div>

    {#if hasNewCommits}
      <div
        class="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <span>
          New commits have been pushed since this review was generated (reviewed
          <span class="font-mono">{shortSha(data.review.reviewed_sha)}</span>, current HEAD
          <span class="font-mono">{shortSha(data.currentHeadSha)}</span>).
        </span>
      </div>
    {/if}

    {#if data.review.status === 'error' && data.review.error_message}
      <div
        class="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300"
      >
        {data.review.error_message}
      </div>
    {/if}

    {#if issueActionError}
      <div
        class="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300"
      >
        {issueActionError}
      </div>
    {/if}
  </div>

  <!-- Split: guide left, issues right -->
  <Splitpanes theme="tim-split" class="min-h-0 flex-1 pb-6">
    <!-- Left: review guide -->
    <Pane minSize={20}>
      <div class="h-full overflow-y-auto pr-1">
        {#if data.review.review_guide}
          <MarkdownContent content={data.review.review_guide} class="text-sm text-foreground" />
        {:else if data.review.status !== 'complete'}
          <p class="text-sm text-muted-foreground">Review guide not yet available.</p>
        {/if}
      </div>
    </Pane>

    <!-- Right: issues -->
    <Pane size={30} minSize={15}>
      <div class="@container h-full space-y-1.5 overflow-y-auto pl-3">
        <h3
          class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase @sm:text-sm"
        >
          Issues
          {#if issues.length > 0}
            <span class="ml-1 font-normal normal-case">
              ({unresolvedCount} of {issues.length} unresolved)
            </span>
          {/if}
        </h3>

        {#if issues.length > 0}
          {#each SEVERITY_ORDER as severity (severity)}
            {@const severityIssues = groupedIssues.get(severity) ?? []}
            {#if severityIssues.length > 0}
              <details open class="group">
                <summary
                  class="flex cursor-pointer list-none items-center gap-2 rounded px-1 py-1 hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <span
                    class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium @sm:text-sm {severityBadgeClass(
                      severity
                    )}"
                  >
                    {formatSeverity(severity)}
                  </span>
                  <span class="text-xs text-muted-foreground @sm:text-sm">
                    {severityIssues.filter((i) => !i.resolved).length}/{severityIssues.length} open
                  </span>
                </summary>
                <ul class="mt-1 space-y-1.5 pl-1">
                  {#each severityIssues as issue (issue.id)}
                    <ReviewIssueCard
                      {issue}
                      actioning={isIssueActioning(issue.id)}
                      copied={copiedIssueId === issue.id}
                      {linkedPlanUuid}
                      {categoryBadgeClass}
                      {issueLocationLabel}
                      {formatCategory}
                      onToggleResolved={handleToggleResolved}
                      onDelete={handleDeleteIssue}
                      onAddToPlan={handleAddIssueToPlan}
                      onCopy={handleCopyIssue}
                    />
                  {/each}
                </ul>
              </details>
            {/if}
          {/each}
        {:else if data.review.status === 'complete'}
          <p class="text-xs text-muted-foreground @sm:text-sm">No issues found.</p>
        {/if}
      </div>
    </Pane>
  </Splitpanes>
</div>
