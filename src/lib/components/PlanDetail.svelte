<script lang="ts">
  import type { PlanDetail } from '$lib/server/db_queries.js';
  import StatusBadge from './StatusBadge.svelte';
  import PriorityBadge from './PriorityBadge.svelte';
  import PrStatusSection from './PrStatusSection.svelte';

  let {
    plan,
    projectId,
    projectName,
    tab = 'plans',
  }: {
    plan: PlanDetail;
    projectId: string;
    projectName?: string;
    tab?: string;
  } = $props();

  function planUrl(uuid: string, depProjectId?: number | null): string {
    const pid = depProjectId ?? projectId;
    return `/projects/${pid}/${tab}/${uuid}`;
  }

  function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
</script>

<div class="space-y-6 p-4">
  <!-- Header -->
  <div>
    <div class="flex items-center gap-2">
      <span class="text-sm font-medium text-muted-foreground">#{plan.planId}</span>
      {#if plan.epic}
        <span
          class="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
        >
          Epic
        </span>
      {/if}
    </div>
    <h2 class="mt-1 text-xl font-semibold text-foreground">{plan.title ?? 'Untitled'}</h2>
    {#if projectName}
      <div class="mt-0.5 text-sm text-muted-foreground">{projectName}</div>
    {/if}
    <div class="mt-2 flex items-center gap-2">
      <StatusBadge status={plan.displayStatus} />
      <PriorityBadge priority={plan.priority} />
    </div>
  </div>

  <!-- Goal -->
  {#if plan.goal}
    <div>
      <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Goal</h3>
      <p class="text-sm text-foreground">{plan.goal}</p>
    </div>
  {/if}

  <!-- Tasks -->
  {#if plan.tasks.length > 0}
    <div>
      <h3 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Tasks ({plan.taskCounts.done}/{plan.taskCounts.total})
      </h3>
      <ul class="space-y-1.5">
        {#each plan.tasks as task (task.id)}
          <li class="flex items-start gap-2 text-sm">
            <span class="mt-0.5 shrink-0">
              {#if task.done}
                <span class="text-green-600 dark:text-green-400">✓</span>
              {:else}
                <span class="text-gray-300 dark:text-gray-500">○</span>
              {/if}
            </span>
            <div class="min-w-0">
              <span class={task.done ? 'text-muted-foreground' : 'text-foreground'}>
                {task.title}
              </span>
              {#if task.description}
                <p class="mt-0.5 text-xs text-muted-foreground">{task.description}</p>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- Dependencies -->
  {#if plan.dependencies.length > 0}
    <div>
      <h3 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Dependencies
      </h3>
      <ul class="space-y-1">
        {#each plan.dependencies as dep (dep.uuid)}
          <li class="flex items-center gap-2 text-sm">
            <a
              href={planUrl(dep.uuid, dep.projectId)}
              data-sveltekit-preload-data
              class="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-left transition-colors hover:bg-gray-100 dark:hover:bg-gray-800
                {dep.isResolved ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400'}"
            >
              {#if dep.planId}
                <span class="text-xs font-medium">#{dep.planId}</span>
              {/if}
              <span class={dep.isResolved ? 'line-through' : ''}>
                {dep.title ?? 'Unknown plan'}
              </span>
              {#if dep.displayStatus}
                <StatusBadge status={dep.displayStatus} />
              {/if}
            </a>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- Parent -->
  {#if plan.parent}
    <div>
      <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Parent Plan
      </h3>
      <a
        href={planUrl(plan.parent.uuid, plan.parent.projectId)}
        data-sveltekit-preload-data
        class="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-sm transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        {#if plan.parent.planId}
          <span class="text-xs font-medium text-muted-foreground">#{plan.parent.planId}</span>
        {/if}
        <span class="text-foreground">{plan.parent.title ?? 'Unknown plan'}</span>
        {#if plan.parent.displayStatus}
          <StatusBadge status={plan.parent.displayStatus} />
        {/if}
      </a>
    </div>
  {/if}

  <!-- Assignment -->
  {#if plan.assignment}
    <div>
      <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Assigned Workspace
      </h3>
      <div class="text-sm text-foreground">
        {#each plan.assignment.workspacePaths as wsPath (wsPath)}
          <div class="truncate">{wsPath}</div>
        {/each}
        {#if plan.assignment.users.length > 0}
          <div class="mt-0.5 text-xs text-muted-foreground">
            Users: {plan.assignment.users.join(', ')}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Tags -->
  {#if plan.tags.length > 0}
    <div>
      <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Tags</h3>
      <div class="flex flex-wrap gap-1">
        {#each plan.tags as tag (tag)}
          <span
            class="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300"
            >{tag}</span
          >
        {/each}
      </div>
    </div>
  {/if}

  <!-- Pull Requests -->
  {#if plan.pullRequests.length > 0 || plan.invalidPrUrls.length > 0}
    <PrStatusSection
      planUuid={plan.uuid}
      prUrls={plan.pullRequests}
      invalidPrUrls={plan.invalidPrUrls}
      initialStatuses={plan.prStatuses}
    />
  {/if}

  <!-- Branch -->
  {#if plan.branch}
    <div>
      <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Branch
      </h3>
      <code class="text-xs text-muted-foreground">{plan.branch}</code>
    </div>
  {/if}

  <!-- Timestamps -->
  <div class="space-y-1 text-xs text-muted-foreground">
    <div>Created: {formatDate(plan.createdAt)}</div>
    <div>Updated: {formatDate(plan.updatedAt)}</div>
  </div>
</div>
