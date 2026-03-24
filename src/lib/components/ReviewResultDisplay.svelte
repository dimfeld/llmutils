<script lang="ts">
  import type { StructuredMessagePayload } from '$lib/types/session.js';

  type ReviewResultPayload = Extract<StructuredMessagePayload, { type: 'review_result' }>;
  type ReviewIssue = ReviewResultPayload['issues'][number];
  type Severity = ReviewIssue['severity'];

  let { message }: { message: ReviewResultPayload } = $props();

  const severityOrder: Severity[] = ['critical', 'major', 'minor', 'info'];

  const severityConfig: Record<Severity, { emoji: string; colorClass: string }> = {
    critical: { emoji: '\u{1F534}', colorClass: 'text-red-400' },
    major: { emoji: '\u{1F7E1}', colorClass: 'text-yellow-400' },
    minor: { emoji: '\u{1F7E0}', colorClass: 'text-orange-400' },
    info: { emoji: '\u{2139}\u{FE0F}', colorClass: 'text-blue-400' },
  };

  let issues = $derived(Array.isArray(message.issues) ? message.issues : []);
  let recommendations = $derived(
    Array.isArray(message.recommendations) ? message.recommendations : []
  );
  let actionItems = $derived(Array.isArray(message.actionItems) ? message.actionItems : []);

  let groupedIssues = $derived.by(() => {
    const groups: Partial<Record<Severity, ReviewIssue[]>> = {};
    for (const issue of issues) {
      const list = groups[issue.severity];
      if (list) {
        list.push(issue);
      } else {
        groups[issue.severity] = [issue];
      }
    }
    return groups;
  });
</script>

<div class="space-y-2">
  <div class="font-medium">
    {#if message.verdict === 'ACCEPTABLE'}
      <span class="text-green-400">{'\u2705'} ACCEPTABLE</span>
    {:else if message.verdict === 'NEEDS_FIXES'}
      <span class="text-red-400">{'\u274C'} NEEDS FIXES</span>
    {:else}
      <span class="text-yellow-400">{'\u2753'} UNKNOWN</span>
    {/if}
  </div>

  {#if message.fixInstructions}
    <div class="text-gray-300">{message.fixInstructions}</div>
  {/if}

  {#if issues.length > 0}
    <div class="space-y-2">
      {#each severityOrder as severity (severity)}
        {@const issues = groupedIssues[severity]}
        {#if issues && issues.length > 0}
          {@const config = severityConfig[severity]}
          <div>
            <div class="font-medium {config.colorClass}">
              {config.emoji}
              {severity.charAt(0).toUpperCase() + severity.slice(1)} ({issues.length})
            </div>
            <div class="space-y-1 pl-4">
              {#each issues as issue, i (i)}
                <div>
                  <span class="text-gray-400">[{issue.category}]</span>
                  {#if issue.file}
                    <span class="text-cyan-400"
                      >{issue.file}{issue.line ? `:${issue.line}` : ''}</span
                    >
                  {/if}
                  <span class="text-gray-200">{issue.content}</span>
                  {#if issue.suggestion}
                    <div class="pl-4 text-gray-400">Suggestion: {issue.suggestion}</div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  {#if recommendations.length > 0}
    <div>
      <div class="font-medium text-gray-300">Recommendations</div>
      <ul class="list-disc pl-6 text-gray-300">
        {#each recommendations as rec, i (i)}
          <li>{rec}</li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if actionItems.length > 0}
    <div>
      <div class="font-medium text-gray-300">Action Items</div>
      <ul class="list-disc pl-6 text-gray-300">
        {#each actionItems as item, i (i)}
          <li>{item}</li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
