<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { afterNavigate } from '$app/navigation';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import { lockWorkspace, unlockWorkspace } from '$lib/remote/workspace_actions.remote.js';
  import WorkspaceBadge from '$lib/components/WorkspaceBadge.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let workspace = $derived(data.workspace);

  let displayName = $derived(
    workspace.name ?? workspace.workspacePath.replace(/\/+$/, '').split('/').pop() ?? 'Unknown'
  );

  let badgeStatus = $derived.by(() => {
    if (workspace.workspaceType === 'primary') return 'primary' as const;
    if (workspace.workspaceType === 'auto') return 'auto' as const;
    if (workspace.isLocked) return 'locked' as const;
    return 'available' as const;
  });

  let submitting = $state(false);
  let errorMessage: string | null = $state(null);

  afterNavigate(({ from, to }) => {
    if (from && to && from.url.pathname !== to.url.pathname) {
      submitting = false;
      errorMessage = null;
    }
  });

  async function handleLock() {
    submitting = true;
    errorMessage = null;
    try {
      await lockWorkspace({ workspaceId: workspace.id });
      await invalidateAll();
    } catch (err) {
      errorMessage = (err as Error).message || 'Failed to lock workspace';
    } finally {
      submitting = false;
    }
  }

  async function handleUnlock() {
    if (workspace.lockInfo?.type === 'pid') {
      const confirmed = confirm(
        `A process is actively using this workspace.\n\n` +
          `PID: ${workspace.lockPid}\n` +
          `Command: ${workspace.lockInfo.command}\n` +
          `Host: ${workspace.lockInfo.hostname}\n\n` +
          `Force-releasing this lock may cause issues. Continue?`
      );
      if (!confirmed) return;
    }

    submitting = true;
    errorMessage = null;
    try {
      await unlockWorkspace({ workspaceId: workspace.id });
      await invalidateAll();
    } catch (err) {
      errorMessage = (err as Error).message || 'Failed to unlock workspace';
    } finally {
      submitting = false;
    }
  }
</script>

<div class="p-6">
  <!-- Header -->
  <div class="mb-6">
    <div class="flex items-center gap-3">
      <h1 class="text-xl font-semibold text-foreground">{displayName}</h1>
      <WorkspaceBadge status={badgeStatus} />
    </div>
    {#if workspace.description}
      <p class="mt-1 text-sm text-muted-foreground">{workspace.description}</p>
    {/if}
  </div>

  <!-- Details -->
  <div class="mb-6 space-y-3">
    <div class="grid grid-cols-[120px_1fr] gap-2 text-sm">
      <span class="text-muted-foreground">Path</span>
      <span class="font-mono text-xs text-foreground">{workspace.workspacePath}</span>

      {#if workspace.branch}
        <span class="text-muted-foreground">Branch</span>
        <span class="text-foreground">
          <span
            class="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-gray-800"
          >
            {workspace.branch}
          </span>
        </span>
      {/if}

      <span class="text-muted-foreground">Type</span>
      <span class="text-foreground capitalize">{workspace.workspaceType}</span>

      {#if workspace.planId}
        <span class="text-muted-foreground">Assigned Plan</span>
        <span class="text-foreground">
          #{workspace.planId} &mdash; {workspace.planTitle ?? 'Untitled'}
        </span>
      {/if}

      <span class="text-muted-foreground">Created</span>
      <span class="text-foreground">{formatRelativeTime(workspace.createdAt)}</span>

      <span class="text-muted-foreground">Updated</span>
      <span class="text-foreground">{formatRelativeTime(workspace.updatedAt)}</span>
    </div>
  </div>

  <!-- Lock Status Section -->
  <div class="rounded-lg border border-border p-4">
    <h2 class="mb-3 text-sm font-semibold text-foreground">Lock Status</h2>

    {#if workspace.isLocked && workspace.lockInfo}
      <div class="mb-4 space-y-2">
        <div class="grid grid-cols-[120px_1fr] gap-2 text-sm">
          <span class="text-muted-foreground">Lock Type</span>
          <span class="text-foreground capitalize">{workspace.lockInfo.type}</span>

          <span class="text-muted-foreground">Command</span>
          <span class="font-mono text-xs text-foreground">{workspace.lockInfo.command}</span>

          <span class="text-muted-foreground">Hostname</span>
          <span class="text-foreground">{workspace.lockInfo.hostname}</span>

          {#if workspace.lockStartedAt}
            <span class="text-muted-foreground">Locked Since</span>
            <span class="text-foreground">{formatRelativeTime(workspace.lockStartedAt)}</span>
          {/if}

          {#if workspace.lockPid}
            <span class="text-muted-foreground">PID</span>
            <span class="font-mono text-xs text-foreground">{workspace.lockPid}</span>
          {/if}
        </div>
      </div>

      <Button variant="destructive" size="sm" disabled={submitting} onclick={handleUnlock}>
        {submitting ? 'Unlocking...' : 'Unlock Workspace'}
      </Button>
    {:else}
      <p class="mb-4 text-sm text-muted-foreground">This workspace is not locked.</p>

      <Button variant="default" size="sm" disabled={submitting} onclick={handleLock}>
        {submitting ? 'Locking...' : 'Lock Workspace'}
      </Button>
    {/if}

    {#if errorMessage}
      <p class="mt-3 text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
    {/if}
  </div>
</div>
