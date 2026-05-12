<script lang="ts">
  import type { StructuredMessagePayload } from '$lib/types/session.js';

  type ExecutionSummaryPayload = Extract<StructuredMessagePayload, { type: 'execution_summary' }>;
  type StepResult = ExecutionSummaryPayload['summary']['steps'][number];

  let { message }: { message: ExecutionSummaryPayload } = $props();

  let summary = $derived(message.summary);
  let hasFailures = $derived(summary.metadata.failedSteps > 0);
  let hasErrors = $derived(summary.errors.length > 0);
  let titleClass = $derived(hasFailures || hasErrors ? 'text-red-400' : 'text-green-400');
  let statusIcon = $derived(hasFailures || hasErrors ? '✖' : '✓');
  let completedSteps = $derived(summary.metadata.totalSteps - summary.metadata.failedSteps);
  let completionPct = $derived(
    summary.metadata.totalSteps > 0
      ? Math.round((completedSteps / summary.metadata.totalSteps) * 100)
      : 0
  );
  let averageStepDuration = $derived(
    summary.steps.length > 0
      ? Math.round(
          summary.steps.reduce((total, step) => total + (step.durationMs ?? 0), 0) /
            summary.steps.length
        )
      : 0
  );

  const stepStatus = (step: StepResult) =>
    step.success
      ? { icon: '✔', colorClass: 'text-green-400', label: 'Completed' }
      : { icon: '✖', colorClass: 'text-red-400', label: 'Failed' };

  function formatDuration(ms?: number): string {
    if (ms == null) return 'n/a';
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const hours = Math.floor(minutes / 60);
    const seconds = totalSeconds % 60;
    const remainingMinutes = minutes % 60;

    if (hours > 0) {
      return `${hours}h ${remainingMinutes}m ${seconds}s`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  function formatTimestamp(iso?: string): string {
    if (!iso) return 'n/a';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  }

  function renderStepOutput(step: StepResult): StepResult['output'] | undefined {
    return step.output;
  }
</script>

<div class="space-y-4">
  <div>
    <div class="font-medium {titleClass}">
      {statusIcon} Execution Summary: {summary.planTitle}
    </div>
    <div class="text-xs text-gray-400">
      ({completedSteps}/{summary.metadata.totalSteps} • {completionPct}%)
    </div>
  </div>

  <div class="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
    <div><span class="text-gray-400">Plan ID:</span> {summary.planId}</div>
    <div><span class="text-gray-400">Mode:</span> {summary.mode}</div>
    <div><span class="text-gray-400">Steps Executed:</span> {summary.metadata.totalSteps}</div>
    <div><span class="text-gray-400">Failed Steps:</span> {summary.metadata.failedSteps}</div>
    <div><span class="text-gray-400">Files Changed:</span> {summary.changedFiles.length}</div>
    <div><span class="text-gray-400">Duration:</span> {formatDuration(summary.durationMs)}</div>
    <div><span class="text-gray-400">Started:</span> {formatTimestamp(summary.startedAt)}</div>
    <div><span class="text-gray-400">Ended:</span> {formatTimestamp(summary.endedAt)}</div>
  </div>

  {#if summary.steps.length > 0}
    <div class="space-y-2">
      <div class="font-medium text-cyan-400">Step Results</div>
      <div class="text-xs text-gray-400">
        Steps: {completedSteps}/{summary.metadata.totalSteps} completed • Avg Step:
        {formatDuration(averageStepDuration)}
      </div>
      <div class="space-y-3 pl-2">
        {#each summary.steps as step, index (step.title + index)}
          {@const status = stepStatus(step)}
          <div class="rounded border border-gray-700 bg-gray-950/40 p-3">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class={status.colorClass}>{status.icon}</span>
              <span class="font-medium text-gray-100">{step.title}</span>
              <span class="text-gray-400">({step.executor})</span>
              <span class="text-gray-500">[#{index + 1}]</span>
              <span class="text-gray-500">{formatDuration(step.durationMs)}</span>
            </div>

            {#if step.errorMessage}
              <div class="mt-2 text-red-300">Error: {step.errorMessage}</div>
            {/if}

            {#if !step.success && renderStepOutput(step)?.failureDetails}
              {@const failureDetails = renderStepOutput(step)!.failureDetails!}
              {#if failureDetails.problems}
                <div class="mt-2 text-red-300">
                  FAILED{failureDetails.sourceAgent ? ` (${failureDetails.sourceAgent})` : ''}:
                  {failureDetails.problems}
                </div>
              {/if}
              {#if failureDetails.requirements?.trim()}
                <div class="mt-2 text-yellow-300">Requirements:</div>
                <pre
                  class="pl-4 whitespace-pre-wrap text-gray-200">{failureDetails.requirements.trim()}</pre>
              {/if}
              {#if failureDetails.solutions?.trim()}
                <div class="mt-2 text-yellow-300">Possible solutions:</div>
                <pre
                  class="pl-4 whitespace-pre-wrap text-gray-200">{failureDetails.solutions.trim()}</pre>
              {/if}
            {/if}

            {#if renderStepOutput(step)?.steps?.length}
              <div class="mt-3 space-y-2">
                {#each renderStepOutput(step)!.steps! as section, sectionIndex (section.title + sectionIndex)}
                  <div>
                    <div class="font-medium text-gray-200">{section.title}</div>
                    {#if section.body.trim()}
                      <pre class="pl-4 whitespace-pre-wrap text-gray-300">{section.body}</pre>
                    {/if}
                  </div>
                {/each}
              </div>
            {:else if renderStepOutput(step)?.content}
              <pre class="mt-3 whitespace-pre-wrap text-gray-200">{renderStepOutput(step)!
                  .content}</pre>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <div class="space-y-2">
    <div class="font-medium text-cyan-400">File Changes</div>
    {#if summary.changedFiles.length === 0}
      <div class="text-gray-400">No changed files detected.</div>
    {:else}
      <div class="space-y-1 pl-2">
        {#each summary.changedFiles as file, index (file + index)}
          <div class="text-gray-200">• {file}</div>
        {/each}
      </div>
    {/if}
  </div>

  <div class={titleClass}>
    {statusIcon}
    {hasFailures || hasErrors
      ? `Execution finished for plan ${summary.planId}`
      : `Completed plan ${summary.planId}`}
  </div>

  {#if summary.errors.length > 0}
    <div class="space-y-2">
      <div class="font-medium text-red-400">Errors</div>
      <div class="space-y-1 pl-2">
        {#each summary.errors as error, index (error + index)}
          <div class="text-red-300">• {error}</div>
        {/each}
      </div>
    </div>
  {/if}
</div>
