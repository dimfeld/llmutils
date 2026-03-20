<script lang="ts">
  import type { EnrichedWorkspace } from '$lib/server/db_queries.js';
  import WorkspaceBadge from './WorkspaceBadge.svelte';

  let {
    workspace,
    projectName,
    planHref = null,
  }: {
    workspace: EnrichedWorkspace;
    projectName?: string;
    planHref?: string | null;
  } = $props();

  let displayName = $derived(
    workspace.name ?? workspace.workspacePath.replace(/\/+$/, '').split('/').pop() ?? 'Unknown'
  );

  let badgeStatus = $derived.by(() => {
    if (workspace.workspaceType === 'primary') return 'primary' as const;
    if (workspace.workspaceType === 'auto') return 'auto' as const;
    if (workspace.isLocked) return 'locked' as const;
    return 'available' as const;
  });
</script>

<div class="rounded-md border border-gray-200 px-3 py-2 transition-colors hover:bg-gray-50">
  <div class="flex items-center gap-2">
    <span class="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">
      {displayName}
    </span>
    <WorkspaceBadge status={badgeStatus} />
  </div>

  {#if projectName}
    <div class="mt-0.5 truncate text-xs text-gray-400">{projectName}</div>
  {/if}

  <div class="mt-1 flex flex-wrap items-center gap-1.5">
    {#if workspace.branch}
      <span
        class="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600"
      >
        {workspace.branch}
      </span>
    {/if}

    {#if workspace.planId}
      {#if planHref}
        <a
          href={planHref}
          data-sveltekit-preload-data
          class="truncate text-xs text-blue-600 hover:text-blue-800 hover:underline"
        >
          Plan #{workspace.planId} &mdash; {workspace.planTitle ?? 'Untitled'}
        </a>
      {:else}
        <span class="truncate text-xs text-gray-500">
          Plan #{workspace.planId} &mdash; {workspace.planTitle ?? 'Untitled'}
        </span>
      {/if}
    {/if}
  </div>

  {#if workspace.isLocked && workspace.lockInfo?.command}
    <div class="mt-1 truncate text-xs text-gray-400">
      {workspace.lockInfo.command}
    </div>
  {/if}
</div>
