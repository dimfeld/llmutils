<script lang="ts">
  import { onMount } from 'svelte';
  import CloudOff from '@lucide/svelte/icons/cloud-off';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
  import Cloud from '@lucide/svelte/icons/cloud';
  import { Popover, PopoverContent, PopoverTrigger } from '$lib/components/ui/popover/index.js';
  import { getGlobalSyncStatus } from '$lib/remote/sync_status.remote.js';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import { getGlobalIndicatorState } from './sync_indicator_state.js';

  // Poll every 10s. The remote query refresh keeps the previously-loaded value
  // visible while the new request is in flight, so the indicator does not flicker.
  const refreshIntervalMs = 10_000;
  onMount(() => {
    const refreshInterval = setInterval(() => {
      void getGlobalSyncStatus().refresh();
    }, refreshIntervalMs);
    return () => clearInterval(refreshInterval);
  });

  // Use .current (skip await) so a transient query error never bubbles up to
  // the SvelteKit error boundary and tears down the whole header.
  let statusQuery = $derived(getGlobalSyncStatus());
  let status = $derived(statusQuery.current);
  let indicator = $derived(getGlobalIndicatorState(status));

  let iconColorClass = $derived(
    indicator.tone === 'error'
      ? 'text-red-400'
      : indicator.tone === 'warning'
        ? 'text-yellow-400'
        : indicator.tone === 'info'
          ? 'text-blue-300'
          : 'text-gray-300'
  );

  function connectionLabel(state: string): string {
    switch (state) {
      case 'online':
        return 'Online';
      case 'offline':
        return 'Offline';
      case 'syncing':
        return 'Syncing';
      case 'sync_error':
        return 'Sync error';
      default:
        return state;
    }
  }
</script>

{#if indicator.visible && status?.enabled}
  <Popover>
    <PopoverTrigger
      openOnHover
      openDelay={150}
      closeDelay={100}
      class={[
        'flex items-center gap-1 rounded-md p-1.5 transition-colors hover:bg-white/10',
        iconColorClass,
      ]}
      aria-label="Sync status: {indicator.label}"
      title={indicator.label}
    >
      {#if indicator.tone === 'error'}
        <AlertTriangle class="size-4" />
      {:else if status.connectionState === 'offline'}
        <CloudOff class="size-4" />
      {:else if indicator.tone === 'info'}
        <RefreshCw class="size-4" />
      {:else}
        <Cloud class="size-4" />
      {/if}
      {#if indicator.count > 0}
        <span class="text-xs font-semibold tabular-nums">
          {indicator.count}
        </span>
      {/if}
    </PopoverTrigger>

    <PopoverContent
      align="end"
      class="w-72 rounded-lg border border-gray-600 bg-gray-800 p-3 text-gray-200 shadow-xl"
    >
      <h3 class="mb-2 text-xs font-semibold tracking-wider text-gray-400 uppercase">Sync status</h3>
      <dl class="space-y-1 text-sm">
        <div class="flex justify-between">
          <dt class="text-gray-400">Role</dt>
          <dd class="font-medium">{status.role}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-gray-400">Connection</dt>
          <dd class="font-medium">{connectionLabel(status.connectionState)}</dd>
        </div>
        {#if status.pending > 0}
          <div class="flex justify-between">
            <dt class="text-gray-400">Pending</dt>
            <dd class="font-medium tabular-nums">{status.pending}</dd>
          </div>
        {/if}
        {#if status.sending > 0}
          <div class="flex justify-between">
            <dt class="text-gray-400">Sending</dt>
            <dd class="font-medium tabular-nums">{status.sending}</dd>
          </div>
        {/if}
        {#if status.failedRetryable > 0}
          <div class="flex justify-between">
            <dt class="text-gray-400">Retrying</dt>
            <dd class="font-medium text-yellow-300 tabular-nums">{status.failedRetryable}</dd>
          </div>
        {/if}
        {#if status.conflict > 0}
          <div class="flex justify-between">
            <dt class="text-gray-400">Conflicts</dt>
            <dd class="font-medium text-red-300 tabular-nums">{status.conflict}</dd>
          </div>
        {/if}
        {#if status.rejected > 0}
          <div class="flex justify-between">
            <dt class="text-gray-400">Rejected</dt>
            <dd class="font-medium text-red-300 tabular-nums">{status.rejected}</dd>
          </div>
        {/if}
        {#if status.oldestPendingAt}
          <div class="flex justify-between">
            <dt class="text-gray-400">Oldest pending</dt>
            <dd class="font-medium">{formatRelativeTime(status.oldestPendingAt)}</dd>
          </div>
        {/if}
      </dl>
      {#if status.rejected > 0}
        <p class="mt-3 border-t border-gray-700 pt-2 text-xs text-gray-400">
          Rejected: sync write permanently failed and will not retry. Run
          <code class="rounded bg-gray-700/70 px-1 py-0.5 text-gray-200">tim sync status</code> on the
          main node to inspect.
        </p>
      {/if}
      {#if status.conflict > 0}
        <p class="mt-3 border-t border-gray-700 pt-2 text-xs text-gray-400">
          Run <code class="rounded bg-gray-700/70 px-1 py-0.5 text-gray-200"
            >tim sync conflicts</code
          >
          on the main node to inspect, then
          <code class="rounded bg-gray-700/70 px-1 py-0.5 text-gray-200">tim sync resolve</code> to resolve.
        </p>
      {/if}
    </PopoverContent>
  </Popover>
{/if}
