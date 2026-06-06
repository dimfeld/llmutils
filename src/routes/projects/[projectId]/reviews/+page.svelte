<script lang="ts">
  import { projectDisplayName } from '$lib/stores/project.svelte.js';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  let projectNamesById = $derived.by(() => {
    const map: Record<number, string> = {};
    for (const project of data.projects) {
      map[project.id] = projectDisplayName(project.repository_id, data.currentUsername);
    }
    return map;
  });

  function reviewHref(review: (typeof data.reviews)[number]): string {
    if (review.pr_url) {
      const prNumber = review.pr_number ?? parsePrNumber(review.pr_url);
      if (prNumber != null) {
        return `/projects/${review.project_id}/prs/${prNumber}/reviews/${review.id}`;
      }
    }

    if (review.plan_uuid) {
      return `/projects/${review.project_id}/plans/${review.plan_uuid}/reviews/${review.id}`;
    }

    return `/projects/${review.project_id}/reviews`;
  }

  function parsePrNumber(prUrl: string): number | null {
    try {
      const url = new URL(prUrl);
      const segments = url.pathname.split('/').filter(Boolean);
      const pullIndex = segments.findIndex((segment) => segment === 'pull' || segment === 'pulls');
      const number = pullIndex >= 0 ? Number(segments[pullIndex + 1]) : NaN;
      return Number.isFinite(number) ? number : null;
    } catch {
      return null;
    }
  }

  function targetLabel(review: (typeof data.reviews)[number]): string {
    if (review.plan_uuid) {
      const prefix = review.plan_id != null ? `Plan #${review.plan_id}` : 'Plan';
      return review.plan_title ? `${prefix}: ${review.plan_title}` : prefix;
    }

    if (review.pr_url) {
      const number = review.pr_number ?? parsePrNumber(review.pr_url);
      const prefix = number != null ? `PR #${number}` : 'Pull request';
      return review.pr_title ? `${prefix}: ${review.pr_title}` : prefix;
    }

    return `Review #${review.id}`;
  }

  function secondaryTarget(review: (typeof data.reviews)[number]): string | null {
    if (review.plan_uuid && review.pr_url) {
      const number = review.pr_number ?? parsePrNumber(review.pr_url);
      return number != null ? `Linked PR #${number}` : review.pr_url;
    }

    if (review.branch) return review.branch;
    return review.pr_url;
  }

  function statusLabel(status: string): string {
    return status.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  }
</script>

<div class="h-full overflow-y-auto">
  <div class="mx-auto max-w-6xl px-6 py-6">
    <div class="mb-5 flex items-end justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold text-foreground">Review Guides</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Latest generated guide per plan or pull request from the past week
        </p>
      </div>
      <div class="text-sm text-muted-foreground tabular-nums">
        {data.reviews.length}
        {data.reviews.length === 1 ? 'guide' : 'guides'}
      </div>
    </div>

    {#if data.reviews.length > 0}
      <div class="overflow-hidden rounded-lg border border-border">
        <table class="w-full border-collapse text-sm">
          <thead class="bg-muted/50 text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th class="px-4 py-2 text-left font-semibold">Target</th>
              <th class="px-4 py-2 text-left font-semibold">Project</th>
              <th class="px-4 py-2 text-right font-semibold">Issues</th>
              <th class="px-4 py-2 text-left font-semibold">Status</th>
              <th class="px-4 py-2 text-left font-semibold">Generated</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            {#each data.reviews as review (review.id)}
              <tr class="hover:bg-muted/40">
                <td class="max-w-md px-4 py-3">
                  <a href={reviewHref(review)} class="block min-w-0">
                    <span class="block truncate font-medium text-foreground">
                      {targetLabel(review)}
                    </span>
                    {#if secondaryTarget(review)}
                      <span class="mt-0.5 block truncate text-xs text-muted-foreground">
                        {secondaryTarget(review)}
                      </span>
                    {/if}
                  </a>
                </td>
                <td class="px-4 py-3 text-muted-foreground">
                  {projectNamesById[review.project_id] ?? `Project ${review.project_id}`}
                </td>
                <td class="px-4 py-3 text-right tabular-nums">
                  <span class="font-medium text-foreground">{review.issue_count}</span>
                  {#if review.issue_count > 0}
                    <span class="text-xs text-muted-foreground">
                      ({review.unresolved_count} open)
                    </span>
                  {/if}
                </td>
                <td class="px-4 py-3">
                  <span
                    class={[
                      'rounded px-2 py-0.5 text-xs font-medium',
                      review.status === 'complete'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                        : review.status === 'error'
                          ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                          : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
                    ]}
                  >
                    {statusLabel(review.status)}
                  </span>
                </td>
                <td class="px-4 py-3 text-muted-foreground" title={review.created_at}>
                  {formatRelativeTime(review.created_at)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="rounded-lg border border-dashed border-border px-6 py-10 text-center">
        <p class="text-sm text-muted-foreground">No review guides generated in the past week.</p>
      </div>
    {/if}
  </div>
</div>
