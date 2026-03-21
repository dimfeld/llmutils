<script lang="ts">
  import type { PrReviewRow } from '$tim/db/pr_status.js';

  let { reviews }: { reviews: PrReviewRow[] } = $props();

  function stateColor(state: string): string {
    switch (state) {
      case 'APPROVED':
        return 'text-green-600 dark:text-green-400';
      case 'CHANGES_REQUESTED':
        return 'text-red-600 dark:text-red-400';
      case 'COMMENTED':
        return 'text-blue-600 dark:text-blue-400';
      case 'PENDING':
        return 'text-yellow-600 dark:text-yellow-400';
      case 'DISMISSED':
        return 'text-gray-500 dark:text-gray-400';
      default:
        return 'text-gray-500 dark:text-gray-400';
    }
  }

  function stateLabel(state: string): string {
    switch (state) {
      case 'APPROVED':
        return 'Approved';
      case 'CHANGES_REQUESTED':
        return 'Changes requested';
      case 'COMMENTED':
        return 'Commented';
      case 'PENDING':
        return 'Pending';
      case 'DISMISSED':
        return 'Dismissed';
      default:
        return state;
    }
  }

  function stateIcon(state: string): string {
    switch (state) {
      case 'APPROVED':
        return '✓';
      case 'CHANGES_REQUESTED':
        return '✗';
      case 'COMMENTED':
        return '💬';
      case 'PENDING':
        return '◌';
      case 'DISMISSED':
        return '—';
      default:
        return '?';
    }
  }
</script>

<ul class="space-y-1">
  {#each reviews as review (review.id)}
    <li class="flex items-center gap-2 text-sm">
      <span class="shrink-0 {stateColor(review.state)}">
        {stateIcon(review.state)}
      </span>
      <span class="min-w-0 flex-1 text-foreground">{review.author}</span>
      <span class="shrink-0 text-xs {stateColor(review.state)}">
        {stateLabel(review.state)}
      </span>
    </li>
  {/each}
</ul>
