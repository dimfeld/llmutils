<script lang="ts">
  import type {
    ReviewCategory,
    ReviewIssueRow,
    ReviewIssueSide,
    ReviewSeverity,
  } from '$tim/db/review.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { untrack } from 'svelte';
  import { buildPatch, validatePatch, type ReviewIssuePatch } from './review_issue_editor_utils.js';
  import { extractRemoteErrorMessage } from './remote_error.js';

  export type { ReviewIssuePatch };

  interface Props {
    issue: ReviewIssueRow;
    saving: boolean;
    onSave: (patch: ReviewIssuePatch) => void | Promise<void>;
    onCancel: () => void;
  }

  let { issue, saving, onSave, onCancel }: Props = $props();

  const SEVERITIES: ReviewSeverity[] = ['critical', 'major', 'minor', 'info'];
  const CATEGORIES: ReviewCategory[] = [
    'security',
    'performance',
    'bug',
    'style',
    'compliance',
    'testing',
    'other',
  ];
  const SIDES: ReviewIssueSide[] = ['RIGHT', 'LEFT'];

  const initial = untrack(() => issue);
  let severity = $state<ReviewSeverity>(initial.severity);
  let category = $state<ReviewCategory>(initial.category);
  let file = $state(initial.file ?? '');
  let startLine = $state(initial.start_line ?? '');
  let line = $state(initial.line ?? '');
  let side = $state<ReviewIssueSide>(initial.side);
  let content = $state(initial.content);
  let suggestion = $state(initial.suggestion ?? '');
  let errorMessage = $state<string | null>(null);

  const SELECT_CLASS =
    'w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-50';

  function formatSeverity(value: ReviewSeverity): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function formatCategory(value: ReviewCategory): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  async function handleSave(event: Event) {
    event.preventDefault();
    errorMessage = null;

    const patch = buildPatch(
      { severity, category, file, startLine, line, side, content, suggestion },
      issue
    );
    if (patch == null) {
      onCancel();
      return;
    }

    const validationError = validatePatch(patch, issue);
    if (validationError) {
      errorMessage = validationError;
      return;
    }

    try {
      await onSave(patch);
    } catch (err) {
      errorMessage = extractRemoteErrorMessage(err);
    }
  }
</script>

<form class="space-y-2" onsubmit={handleSave}>
  <div class="grid grid-cols-2 gap-2">
    <div class="space-y-1">
      <Label for="issue-{issue.id}-severity" class="text-[10px] text-muted-foreground">
        Severity
      </Label>
      <select
        id="issue-{issue.id}-severity"
        class={SELECT_CLASS}
        bind:value={severity}
        disabled={saving}
      >
        {#each SEVERITIES as value (value)}
          <option {value}>{formatSeverity(value)}</option>
        {/each}
      </select>
    </div>
    <div class="space-y-1">
      <Label for="issue-{issue.id}-category" class="text-[10px] text-muted-foreground">
        Category
      </Label>
      <select
        id="issue-{issue.id}-category"
        class={SELECT_CLASS}
        bind:value={category}
        disabled={saving}
      >
        {#each CATEGORIES as value (value)}
          <option {value}>{formatCategory(value)}</option>
        {/each}
      </select>
    </div>
  </div>

  <div class="space-y-1">
    <Label for="issue-{issue.id}-file" class="text-[10px] text-muted-foreground">File</Label>
    <Input
      id="issue-{issue.id}-file"
      bind:value={file}
      disabled={saving}
      placeholder="path/to/file.ts"
      class="h-8 text-xs"
    />
  </div>

  <div class="grid grid-cols-3 gap-2">
    <div class="space-y-1">
      <Label for="issue-{issue.id}-start-line" class="text-[10px] text-muted-foreground">
        Start line
      </Label>
      <Input
        id="issue-{issue.id}-start-line"
        bind:value={startLine}
        disabled={saving}
        inputmode="numeric"
        placeholder="—"
        class="h-8 text-xs"
      />
    </div>
    <div class="space-y-1">
      <Label for="issue-{issue.id}-line" class="text-[10px] text-muted-foreground">Line</Label>
      <Input
        id="issue-{issue.id}-line"
        bind:value={line}
        disabled={saving}
        inputmode="numeric"
        placeholder="—"
        class="h-8 text-xs"
      />
    </div>
    <div class="space-y-1">
      <Label for="issue-{issue.id}-side" class="text-[10px] text-muted-foreground">Side</Label>
      <select id="issue-{issue.id}-side" class={SELECT_CLASS} bind:value={side} disabled={saving}>
        {#each SIDES as value (value)}
          <option {value}>{value}</option>
        {/each}
      </select>
    </div>
  </div>

  <div class="space-y-1">
    <Label for="issue-{issue.id}-content" class="text-[10px] text-muted-foreground">Content</Label>
    <Textarea
      id="issue-{issue.id}-content"
      bind:value={content}
      disabled={saving}
      required
      class="min-h-20 text-xs"
    />
  </div>

  <div class="space-y-1">
    <Label for="issue-{issue.id}-suggestion" class="text-[10px] text-muted-foreground">
      Suggestion (optional)
    </Label>
    <Textarea
      id="issue-{issue.id}-suggestion"
      bind:value={suggestion}
      disabled={saving}
      class="min-h-16 text-xs"
    />
  </div>

  {#if errorMessage}
    <p class="text-[10px] text-red-600 dark:text-red-400">{errorMessage}</p>
  {/if}

  <div class="flex items-center gap-2">
    <Button type="submit" size="sm" disabled={saving}>
      {saving ? 'Saving…' : 'Save'}
    </Button>
    <Button type="button" size="sm" variant="outline" onclick={onCancel} disabled={saving}>
      Cancel
    </Button>
  </div>
</form>
