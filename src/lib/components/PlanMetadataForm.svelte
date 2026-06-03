<script lang="ts">
  import { untrack } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import type { PlanPickerOption } from '$lib/server/plan_picker_queries.js';
  import { normalizePlanMetadataFormPayload } from './plan_metadata_form_utils.js';
  import PlanPicker from './PlanPicker.svelte';
  import PlanPickerMulti from './PlanPickerMulti.svelte';

  export interface PlanMetadataFormValue {
    title: string;
    goal: string;
    note: string;
    details: string;
    priority: string;
    status: string;
    simple: boolean;
    tags: string[];
    parentUuid: string | null;
    basePlanUuid: string | null;
    dependencyUuids: string[];
  }

  export type { PlanPickerOption };

  export interface PlanMetadataFormInitialValue {
    title?: string;
    goal?: string;
    note?: string;
    details?: string;
    priority?: string;
    status?: string;
    simple?: boolean;
    tags?: string[];
    parent?: PlanPickerOption | null;
    basePlan?: PlanPickerOption | null;
    dependencies?: PlanPickerOption[];
  }

  const STATUSES = [
    { value: 'pending', label: 'Pending' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'needs_review', label: 'Needs Review' },
    { value: 'reviewed', label: 'Reviewed' },
    { value: 'done', label: 'Done' },
    { value: 'cancelled', label: 'Cancelled' },
    { value: 'deferred', label: 'Deferred' },
  ];

  const PRIORITIES = [
    { value: 'urgent', label: 'Urgent' },
    { value: 'high', label: 'High' },
    { value: 'medium', label: 'Medium' },
    { value: 'low', label: 'Low' },
    { value: 'maybe', label: 'Maybe' },
  ];

  function sortedValues(values: string[]): string[] {
    return [...values].toSorted();
  }

  function formComparable(value: PlanMetadataFormValue): string {
    return JSON.stringify({
      ...value,
      tags: sortedValues(value.tags),
      dependencyUuids: sortedValues(value.dependencyUuids),
    });
  }

  let {
    projectId,
    mode,
    initialValue = {},
    submitLabel = 'Create',
    submitting = false,
    error = null,
    currentPlanUuid = null,
    cancelHref = undefined,
    onsubmit,
  }: {
    projectId: number;
    mode: 'create' | 'edit';
    initialValue?: PlanMetadataFormInitialValue;
    submitLabel?: string;
    submitting?: boolean;
    error?: string | null;
    currentPlanUuid?: string | null;
    cancelHref?: string;
    onsubmit: (value: PlanMetadataFormValue) => void;
  } = $props();

  let title = $state(untrack(() => initialValue.title ?? ''));
  let goal = $state(untrack(() => initialValue.goal ?? ''));
  let note = $state(untrack(() => initialValue.note ?? ''));
  let details = $state(untrack(() => initialValue.details ?? ''));
  let priority = $state(untrack(() => initialValue.priority ?? 'medium'));
  let status = $state(untrack(() => initialValue.status ?? 'pending'));
  let simple = $state(untrack(() => initialValue.simple ?? false));
  let tagsInput = $state(untrack(() => (initialValue.tags ?? []).join(', ')));
  let parentPlan = $state<PlanPickerOption | null>(untrack(() => initialValue.parent ?? null));
  let basePlan = $state<PlanPickerOption | null>(untrack(() => initialValue.basePlan ?? null));
  let dependencies = $state<PlanPickerOption[]>(untrack(() => initialValue.dependencies ?? []));

  let initialComparable = untrack(() =>
    formComparable(
      normalizePlanMetadataFormPayload({
        title: initialValue.title ?? '',
        goal: initialValue.goal ?? '',
        note: initialValue.note ?? '',
        details: initialValue.details ?? '',
        priority: initialValue.priority ?? 'medium',
        status: initialValue.status ?? 'pending',
        simple: initialValue.simple ?? false,
        tagsInput: (initialValue.tags ?? []).join(', '),
        parentPlan: initialValue.parent ?? null,
        basePlan: initialValue.basePlan ?? null,
        dependencies: initialValue.dependencies ?? [],
      })
    )
  );
  let currentComparable = $derived(
    formComparable(
      normalizePlanMetadataFormPayload({
        title,
        goal,
        note,
        details,
        priority,
        status,
        simple,
        tagsInput,
        parentPlan,
        basePlan,
        dependencies,
      })
    )
  );
  let isDirty = $derived(mode === 'create' || currentComparable !== initialComparable);
  let canSubmit = $derived(title.trim().length > 0 && !submitting && isDirty);
  let effectiveCancelHref = $derived(
    cancelHref ??
      (mode === 'edit' && currentPlanUuid
        ? `/projects/${projectId}/plans/${currentPlanUuid}`
        : `/projects/${projectId}/plans`)
  );

  function handleSubmit() {
    if (!canSubmit) return;

    const value: PlanMetadataFormValue = normalizePlanMetadataFormPayload({
      title,
      goal,
      note,
      details,
      priority,
      status,
      simple,
      tagsInput,
      parentPlan,
      basePlan,
      dependencies,
    });

    onsubmit(value);
  }
</script>

<form
  class="space-y-6"
  onsubmit={(e) => {
    e.preventDefault();
    handleSubmit();
  }}
>
  <!-- Title -->
  <div class="rounded-lg border border-border p-4">
    <div class="space-y-3">
      <div>
        <Label for="plan-title" class="text-sm font-medium text-foreground">Title</Label>
        <p class="text-sm text-muted-foreground">Required. A short name for the plan.</p>
      </div>
      <Input
        id="plan-title"
        placeholder="Plan title"
        bind:value={title}
        aria-invalid={title.trim().length === 0 ? 'true' : undefined}
      />
    </div>
  </div>

  <!-- Goal -->
  <div class="rounded-lg border border-border p-4">
    <div class="space-y-3">
      <Label for="plan-goal" class="text-sm font-medium text-foreground">Goal</Label>
      <Input id="plan-goal" placeholder="What should this plan accomplish?" bind:value={goal} />
    </div>
  </div>

  <!-- Details -->
  <div class="rounded-lg border border-border p-4">
    <div class="space-y-3">
      <Label for="plan-details" class="text-sm font-medium text-foreground">Details</Label>
      <Textarea
        id="plan-details"
        placeholder="Additional context, requirements, or notes (Markdown supported)"
        bind:value={details}
      />
    </div>
  </div>

  <!-- Note -->
  <div class="rounded-lg border border-border p-4">
    <div class="space-y-3">
      <Label for="plan-note" class="text-sm font-medium text-foreground">Note</Label>
      <Textarea id="plan-note" placeholder="Internal note (Markdown supported)" bind:value={note} />
    </div>
  </div>

  <!-- Priority & Status -->
  <div class="rounded-lg border border-border p-4">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div class="space-y-2">
        <Label for="plan-priority" class="text-sm font-medium text-foreground">Priority</Label>
        <select
          id="plan-priority"
          class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          bind:value={priority}
        >
          {#each PRIORITIES as p (p.value)}
            <option value={p.value}>{p.label}</option>
          {/each}
        </select>
      </div>

      <div class="space-y-2">
        <Label for="plan-status" class="text-sm font-medium text-foreground">Status</Label>
        <select
          id="plan-status"
          class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          bind:value={status}
        >
          {#each STATUSES as s (s.value)}
            <option value={s.value}>{s.label}</option>
          {/each}
        </select>
      </div>
    </div>
  </div>

  <!-- Simple flag -->
  <div class="rounded-lg border border-border p-4">
    <div class="flex items-center justify-between">
      <div>
        <Label for="plan-simple" class="text-sm font-medium text-foreground">Simple Plan</Label>
        <p class="text-sm text-muted-foreground">
          Run the agent directly without going through plan generation.
        </p>
      </div>
      <Switch id="plan-simple" bind:checked={simple} />
    </div>
  </div>

  <!-- Tags -->
  <div class="rounded-lg border border-border p-4">
    <div class="space-y-3">
      <div>
        <Label for="plan-tags" class="text-sm font-medium text-foreground">Tags</Label>
        <p class="text-sm text-muted-foreground">Comma-separated list of tags.</p>
      </div>
      <Input id="plan-tags" placeholder="e.g. frontend, bugfix, urgent" bind:value={tagsInput} />
    </div>
  </div>

  <!-- Relationships -->
  <div class="rounded-lg border border-border p-4">
    <div class="space-y-4">
      <h3 class="text-sm font-medium text-foreground">Relationships</h3>

      <PlanPicker
        {projectId}
        relation="parent"
        {currentPlanUuid}
        bind:selected={parentPlan}
        label="Parent Plan"
        id="plan-parent"
      />

      <PlanPicker
        {projectId}
        relation="basePlan"
        {currentPlanUuid}
        bind:selected={basePlan}
        label="Base Plan"
        id="plan-base"
      />

      <PlanPickerMulti
        {projectId}
        relation="dependency"
        {currentPlanUuid}
        bind:selected={dependencies}
        label="Dependencies"
        id="plan-dependencies"
      />
    </div>
  </div>

  <!-- Submit -->
  <div class="flex items-center gap-3">
    <Button type="submit" disabled={!canSubmit}>
      {submitting ? `${submitLabel}...` : submitLabel}
    </Button>
    <a href={effectiveCancelHref} class="text-sm text-muted-foreground hover:text-foreground">
      Cancel
    </a>
    {#if error}
      <p class="text-sm text-red-600 dark:text-red-400">{error}</p>
    {/if}
  </div>
</form>
