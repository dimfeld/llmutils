<script lang="ts">
  import { projectDisplayName } from '$lib/stores/project.svelte.js';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import type { PageProps } from './$types';
  import type { ActivityJob } from './+page.server';

  let { data }: PageProps = $props();

  let projectNamesById = $derived.by(() => {
    const map: Record<number, string> = {};
    for (const project of data.projects) {
      map[project.id] = projectDisplayName(project.repository_id, data.currentUsername);
    }
    return map;
  });

  const JOB_TYPE_LABELS: Record<string, string> = {
    agent: 'Run agent',
    'agent-multi': 'Run agents',
    review: 'Review guide',
    'review-guide': 'Review guide',
    autoreview: 'Autoreview',
    proof: 'Generate proof',
    generate: 'Generate plan',
    chat: 'Chat',
    rebase: 'Rebase',
    'update-docs': 'Update docs',
    'pr-create': 'Create PR',
    'pr-fix': 'Fix PR',
    'run-prompt': 'Run prompt',
    shell: 'Shell',
  };

  function jobTypeLabel(jobType: string): string {
    return JOB_TYPE_LABELS[jobType] ?? jobType;
  }

  function prefersPrTarget(job: ActivityJob): boolean {
    return (
      job.pr_url != null &&
      ['review-guide', 'autoreview', 'pr-create', 'pr-fix'].includes(job.job_type)
    );
  }

  function planTargetLabel(job: ActivityJob): string {
    const prefix = job.plan_id != null ? `Plan #${job.plan_id}` : 'Plan';
    return job.plan_title ? `${prefix}: ${job.plan_title}` : prefix;
  }

  function prTargetLabel(job: ActivityJob): string {
    return job.pr_number != null ? `PR #${job.pr_number}` : 'Pull request';
  }

  function targetLabel(job: ActivityJob): string {
    if (prefersPrTarget(job)) {
      return prTargetLabel(job);
    }

    if (job.plan_uuid) {
      return planTargetLabel(job);
    }

    if (job.pr_url) {
      return prTargetLabel(job);
    }

    return '—';
  }

  function secondaryTarget(job: ActivityJob): string | null {
    if (prefersPrTarget(job) && job.plan_uuid) {
      return planTargetLabel(job);
    }
    if (job.plan_uuid && job.pr_number != null) {
      return `Linked PR #${job.pr_number}`;
    }
    return null;
  }

  function statusLabel(status: string): string {
    return status.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  }
</script>

<div class="h-full overflow-y-auto">
  <div class="mx-auto max-w-6xl px-6 py-6">
    <div class="mb-5 flex items-end justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold text-foreground">Activity</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Recently run jobs — agents, review guides, proofs, plan generation and more
        </p>
      </div>
      <div class="text-sm text-muted-foreground tabular-nums">
        {data.activity.length}
        {data.activity.length === 1 ? 'job' : 'jobs'}
      </div>
    </div>

    {#if data.activity.length > 0}
      <div class="overflow-hidden rounded-lg border border-border">
        <table class="w-full border-collapse text-sm">
          <thead class="bg-muted/50 text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th class="px-4 py-2 text-left font-semibold">Job</th>
              <th class="px-4 py-2 text-left font-semibold">Target</th>
              <th class="px-4 py-2 text-left font-semibold">Project</th>
              <th class="px-4 py-2 text-left font-semibold">Status</th>
              <th class="px-4 py-2 text-left font-semibold">Started</th>
              <th class="px-4 py-2 text-right font-semibold">Output</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            {#each data.activity as job (job.id)}
              <tr class="hover:bg-muted/40">
                <td class="px-4 py-3 font-medium text-foreground">
                  {jobTypeLabel(job.job_type)}
                </td>
                <td class="max-w-md px-4 py-3">
                  <span class="block min-w-0">
                    <span class="block truncate text-foreground">{targetLabel(job)}</span>
                    {#if secondaryTarget(job)}
                      <span class="mt-0.5 block truncate text-xs text-muted-foreground">
                        {secondaryTarget(job)}
                      </span>
                    {/if}
                  </span>
                </td>
                <td class="px-4 py-3 text-muted-foreground">
                  {job.project_id != null
                    ? (projectNamesById[job.project_id] ?? `Project ${job.project_id}`)
                    : '—'}
                </td>
                <td class="px-4 py-3">
                  <span
                    class={[
                      'rounded px-2 py-0.5 text-xs font-medium',
                      job.status === 'completed'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                        : job.status === 'failed'
                          ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                          : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
                    ]}
                  >
                    {statusLabel(job.status)}
                  </span>
                </td>
                <td class="px-4 py-3 text-muted-foreground" title={job.started_at}>
                  {formatRelativeTime(job.started_at)}
                </td>
                <td class="px-4 py-3 text-right">
                  {#if job.outputHref}
                    <a
                      href={job.outputHref}
                      class="text-sm font-medium text-primary hover:underline"
                      target={job.outputExternal ? '_blank' : undefined}
                      rel={job.outputExternal ? 'noopener noreferrer' : undefined}
                    >
                      View output{job.outputExternal ? ' ↗' : ''}
                    </a>
                  {:else}
                    <span class="text-xs text-muted-foreground">—</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="rounded-lg border border-dashed border-border px-6 py-10 text-center">
        <p class="text-sm text-muted-foreground">No jobs have been run recently.</p>
      </div>
    {/if}
  </div>
</div>
