<script lang="ts">
  import type { PrCheckRunRow } from '$tim/db/pr_status.js';

  let { checks }: { checks: PrCheckRunRow[] } = $props();

  function conclusionColor(conclusion: string | null, status: string): string {
    if (
      status === 'in_progress' ||
      status === 'queued' ||
      status === 'pending' ||
      status === 'waiting' ||
      status === 'requested'
    ) {
      return 'text-yellow-600 dark:text-yellow-400';
    }
    switch (conclusion) {
      case 'success':
        return 'text-green-600 dark:text-green-400';
      case 'failure':
      case 'timed_out':
      case 'startup_failure':
        return 'text-red-600 dark:text-red-400';
      case 'action_required':
        return 'text-orange-600 dark:text-orange-400';
      case 'cancelled':
      case 'skipped':
      case 'neutral':
      case 'stale':
        return 'text-gray-500 dark:text-gray-400';
      default:
        return 'text-gray-500 dark:text-gray-400';
    }
  }

  function conclusionIcon(conclusion: string | null, status: string): string {
    if (
      status === 'in_progress' ||
      status === 'queued' ||
      status === 'pending' ||
      status === 'waiting' ||
      status === 'requested'
    ) {
      return '◌';
    }
    switch (conclusion) {
      case 'success':
        return '✓';
      case 'failure':
      case 'timed_out':
      case 'startup_failure':
        return '✗';
      case 'action_required':
        return '!';
      case 'cancelled':
        return '⊘';
      case 'skipped':
      case 'neutral':
        return '—';
      default:
        return '?';
    }
  }

  function displayLabel(conclusion: string | null, status: string): string {
    if (status === 'in_progress') return 'In progress';
    if (
      status === 'queued' ||
      status === 'pending' ||
      status === 'waiting' ||
      status === 'requested'
    )
      return 'Pending';
    return conclusion ?? status;
  }
</script>

<ul class="space-y-1">
  {#each checks as check (check.id)}
    <li class="flex items-center gap-2 text-sm">
      <span class="shrink-0 {conclusionColor(check.conclusion, check.status)}">
        {conclusionIcon(check.conclusion, check.status)}
      </span>
      <span class="min-w-0 flex-1 truncate text-foreground">{check.name}</span>
      <span class="shrink-0 text-xs {conclusionColor(check.conclusion, check.status)}">
        {displayLabel(check.conclusion, check.status)}
      </span>
      {#if check.details_url}
        <a
          href={check.details_url}
          target="_blank"
          rel="noopener noreferrer"
          class="shrink-0 text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          Details
        </a>
      {/if}
    </li>
  {/each}
</ul>
