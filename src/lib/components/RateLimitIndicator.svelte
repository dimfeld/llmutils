<script lang="ts">
  import { onDestroy } from 'svelte';
  import Gauge from '@lucide/svelte/icons/gauge';
  import { Popover, PopoverContent, PopoverTrigger } from '$lib/components/ui/popover/index.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import type { RateLimitEntry } from '$lib/types/session.js';

  const sessionManager = useSessionManager();

  let now = $state(Date.now());

  // Tick every 60s to update staleness/reset times and filter expired entries
  const tickInterval = setInterval(() => {
    now = Date.now();
  }, 60_000);
  onDestroy(() => clearInterval(tickInterval));

  let entries = $derived.by(() => {
    // Filter out expired entries client-side. `now` dependency makes this reactive.
    return sessionManager.rateLimitState.entries.filter(
      (e) => e.resetsAtMs == null || e.resetsAtMs > now
    );
  });
  let hasEntries = $derived(entries.length > 0);

  let worstPercent = $derived.by(() => {
    let worst: number | null = null;
    for (const entry of entries) {
      if (entry.belowThreshold || entry.usedPercent == null) continue;
      if (worst == null || entry.usedPercent > worst) {
        worst = entry.usedPercent;
      }
    }
    return worst;
  });

  let iconColorClass = $derived.by(() => {
    if (worstPercent == null) return 'text-gray-300';
    if (worstPercent >= 90) return 'text-red-400';
    if (worstPercent >= 80) return 'text-yellow-400';
    return 'text-gray-300';
  });

  function formatUsage(entry: RateLimitEntry): string {
    if (entry.belowThreshold) return '< 75%';
    if (entry.usedPercent == null) return 'Unknown';
    return `${Math.round(entry.usedPercent)}%`;
  }

  function formatResetTime(resetsAtMs: number | null): string {
    if (resetsAtMs == null) return '';
    const diffMs = resetsAtMs - Date.now();
    if (diffMs <= 0) return 'Expired';

    const totalMinutes = Math.floor(diffMs / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remainingHours = hours % 24;
      return `Resets in ${days}d ${remainingHours}h`;
    }
    if (hours > 0) {
      return `Resets in ${hours}h ${minutes}m`;
    }
    return `Resets in ${minutes}m`;
  }

  function formatStaleness(updatedAt: string): string {
    const diffMs = Date.now() - new Date(updatedAt).getTime();
    if (Number.isNaN(diffMs) || diffMs < 60_000) return 'just now';

    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function providerLabel(entry: RateLimitEntry): string {
    const name = entry.provider === 'claude' ? 'Claude' : 'Codex';
    return `${name} ${entry.label}`;
  }
</script>

{#if hasEntries}
  <Popover>
    <PopoverTrigger
      openOnHover
      openDelay={150}
      closeDelay={100}
      class={['rounded-md p-1.5 transition-colors hover:bg-white/10', iconColorClass]}
      aria-label="Rate limit usage"
      title="Rate limit usage"
    >
      <Gauge class="size-4" />
    </PopoverTrigger>

    <PopoverContent
      align="end"
      class="w-64 rounded-lg border border-gray-600 bg-gray-800 p-3 text-gray-200 shadow-xl"
    >
      <h3 class="mb-2 text-xs font-semibold tracking-wider text-gray-400 uppercase">Rate Limits</h3>
      <div class="space-y-2">
        {#each entries as entry (entry.provider + ':' + entry.label)}
          <div class="rounded bg-gray-700/50 px-2 py-1.5">
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium text-gray-200">{providerLabel(entry)}</span>
              <span
                class={[
                  'text-sm font-semibold',
                  entry.belowThreshold || entry.usedPercent == null
                    ? 'text-gray-300'
                    : entry.usedPercent >= 90
                      ? 'text-red-400'
                      : entry.usedPercent >= 80
                        ? 'text-yellow-400'
                        : 'text-green-400',
                ]}
              >
                {formatUsage(entry)}
              </span>
            </div>
            <div class="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
              {#if entry.resetsAtMs != null}
                <span>{formatResetTime(entry.resetsAtMs)}</span>
              {/if}
              <span>Updated {formatStaleness(entry.updatedAt)}</span>
            </div>
          </div>
        {/each}
      </div>
    </PopoverContent>
  </Popover>
{/if}
