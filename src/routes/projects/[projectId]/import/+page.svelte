<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { RadioGroup, RadioGroupItem } from '$lib/components/ui/radio-group/index.js';
  import { fetchIssueForImport, importIssue } from '$lib/remote/issue_import.remote.js';
  import { renderPlanContentHtml } from '$lib/utils/plan_content.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  type ImportMode = 'single' | 'separate' | 'merged';

  interface FetchedIssue {
    issueData: {
      issue: { title: string; htmlUrl: string; number: number | string; body: string | null };
      comments: Array<{ body: string | null }>;
      children?: FetchedIssue['issueData'][];
    };
    tracker: {
      available: boolean;
      trackerType: string;
      displayName: string;
      supportsHierarchical: boolean;
    };
  }

  // Step 1 state
  let identifier = $state('');
  let mode: ImportMode = $state('single');
  let fetching = $state(false);
  let fetchError: string | null = $state(null);

  // Step 2 state
  let fetchedResult: FetchedIssue | null = $state.raw(null);
  let step = $derived(fetchedResult ? 2 : 1);
  let importing = $state(false);
  let importError: string | null = $state(null);

  // Content selection state for parent
  let parentContentChecked: boolean[] = $state([]);

  // Content selection state for children (separate/merged modes)
  let childSelected: boolean[] = $state([]);
  let childContentChecked: boolean[][] = $state([]);

  function initSelectionState(result: FetchedIssue) {
    const issueData = result.issueData;
    const contentCount = 1 + issueData.comments.length;
    // Body checked by default only if it has content, comments unchecked
    parentContentChecked = Array.from(
      { length: contentCount },
      (_, i) => i === 0 && hasContent(issueData.issue.body)
    );

    const children = issueData.children ?? [];
    childSelected = children.map(() => true);
    childContentChecked = children.map((child) => {
      const childCount = 1 + child.comments.length;
      return Array.from({ length: childCount }, (_, i) => i === 0 && hasContent(child.issue.body));
    });
  }

  async function handleFetch() {
    if (!identifier.trim()) return;

    fetching = true;
    fetchError = null;
    try {
      const result = await fetchIssueForImport({
        identifier: identifier.trim(),
        mode,
        projectId: data.numericProjectId,
      });
      fetchedResult = result as FetchedIssue;
      initSelectionState(fetchedResult);
    } catch (err) {
      fetchError = (err as Error).message || 'Failed to fetch issue';
    } finally {
      fetching = false;
    }
  }

  function handleBack() {
    fetchedResult = null;
    importError = null;
  }

  async function handleImport() {
    if (!fetchedResult) return;

    const selectedParentContent: number[] = [];
    for (let i = 0; i < parentContentChecked.length; i++) {
      if (parentContentChecked[i]) selectedParentContent.push(i);
    }

    const selectedChildIndices: number[] = [];
    const selectedChildContent: Record<string, number[]> = {};

    if (mode !== 'single') {
      for (let i = 0; i < childSelected.length; i++) {
        if (!childSelected[i]) continue;
        selectedChildIndices.push(i);
        const contentIndexes: number[] = [];
        for (let j = 0; j < (childContentChecked[i]?.length ?? 0); j++) {
          if (childContentChecked[i][j]) contentIndexes.push(j);
        }
        selectedChildContent[String(i)] = contentIndexes;
      }
    }

    importing = true;
    importError = null;
    try {
      await importIssue({
        projectId: data.numericProjectId,
        mode,
        issueData: fetchedResult.issueData,
        selectedParentContent,
        selectedChildIndices,
        selectedChildContent,
      });
      // If this works it redirects to the plan page
    } catch (err) {
      importError = (err as Error).message || 'Failed to import issue';
    } finally {
      importing = false;
    }
  }

  function getContentLabel(index: number, isBody: boolean): string {
    return isBody ? 'Issue body' : `Comment ${index}`;
  }

  function hasContent(body: string | null | undefined): boolean {
    return Boolean(body?.trim());
  }
</script>

<div class="p-6">
  <div class="mb-6">
    <h1 class="text-xl font-semibold text-foreground">
      Import Issue from {data.displayName}
    </h1>
    <p class="mt-1 text-sm text-muted-foreground">Import an issue into a new plan.</p>
  </div>

  {#if step === 1}
    <!-- Step 1: Issue Input -->
    <div class="space-y-6">
      <div class="rounded-lg border border-border p-4">
        <div class="space-y-4">
          <div class="space-y-2">
            <Label for="issue-identifier" class="text-sm font-medium text-foreground">
              Issue Identifier
            </Label>
            <p class="text-sm text-muted-foreground">Enter an issue ID, URL, or branch name.</p>
            <Input
              id="issue-identifier"
              placeholder={data.trackerType === 'linear' ? 'TEAM-123' : '#123 or owner/repo#123'}
              bind:value={identifier}
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' && identifier.trim()) handleFetch();
              }}
            />
          </div>

          <div class="space-y-2">
            <Label class="text-sm font-medium text-foreground">Import Mode</Label>
            <RadioGroup bind:value={mode}>
              <div class="flex items-center gap-2">
                <RadioGroupItem value="single" id="mode-single" />
                <Label for="mode-single" class="cursor-pointer text-sm">Single issue</Label>
              </div>
              {#if data.supportsHierarchical}
                <div class="flex items-center gap-2">
                  <RadioGroupItem value="separate" id="mode-separate" />
                  <Label for="mode-separate" class="cursor-pointer text-sm">
                    With subissues (separate plans)
                  </Label>
                </div>
                <div class="flex items-center gap-2">
                  <RadioGroupItem value="merged" id="mode-merged" />
                  <Label for="mode-merged" class="cursor-pointer text-sm">
                    With subissues (merged into one plan)
                  </Label>
                </div>
              {/if}
            </RadioGroup>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <Button disabled={fetching || !identifier.trim()} onclick={handleFetch}>
          {fetching ? 'Fetching...' : 'Fetch Issue'}
        </Button>
        <a
          href="/projects/{page.params.projectId}/plans"
          class="text-sm text-muted-foreground hover:text-foreground"
        >
          Cancel
        </a>
        {#if fetchError}
          <p class="text-sm text-red-600 dark:text-red-400">{fetchError}</p>
        {/if}
      </div>
    </div>
  {:else if fetchedResult}
    <!-- Step 2: Content Selection -->
    <div class="space-y-6">
      <div class="rounded-lg border border-border p-4">
        <div class="mb-4 flex items-start justify-between">
          <div>
            <h2 class="text-lg font-medium text-foreground">
              {fetchedResult.issueData.issue.title}
            </h2>
            <p class="mt-1 text-sm text-muted-foreground">
              #{fetchedResult.issueData.issue.number} &middot; Select which content to include in the
              plan.
            </p>
          </div>
        </div>

        <!-- Parent issue content -->
        <div class="space-y-2">
          <h3 class="text-sm font-medium text-foreground">
            {#if mode !== 'single' && (fetchedResult.issueData.children?.length ?? 0) > 0}
              Parent Issue Content
            {:else}
              Issue Content
            {/if}
          </h3>
          <div class="ml-1 space-y-1">
            {#each parentContentChecked as checked, index}
              {@const isBody = index === 0}
              {@const content = isBody
                ? fetchedResult.issueData.issue.body
                : fetchedResult.issueData.comments[index - 1]?.body}
              {#if hasContent(content)}
                <div class="py-1">
                  <label class="flex items-center gap-2">
                    <Checkbox bind:checked={parentContentChecked[index]} />
                    <span class="text-sm">{getContentLabel(index, isBody)}</span>
                  </label>
                  <pre
                    class="plan-rendered-content mt-1 ml-6 line-clamp-10 text-xs whitespace-pre-wrap text-muted-foreground">{@html renderPlanContentHtml(
                      content?.trim() ?? ''
                    )}</pre>
                </div>
              {/if}
            {/each}
          </div>
        </div>

        <!-- Child issues (separate/merged modes) -->
        {#if mode !== 'single' && (fetchedResult.issueData.children?.length ?? 0) > 0}
          <div class="mt-4 space-y-3">
            <h3 class="text-sm font-medium text-foreground">Subissues</h3>
            {#each fetchedResult.issueData.children ?? [] as child, childIndex (child.issue.number)}
              <div class="ml-1 rounded border border-border/50 p-3">
                <label class="flex items-center gap-2">
                  <Checkbox bind:checked={childSelected[childIndex]} />
                  <span class="text-sm font-medium">
                    #{child.issue.number}: {child.issue.title}
                  </span>
                </label>

                {#if childSelected[childIndex]}
                  <div class="mt-2 ml-6 space-y-1">
                    {#each childContentChecked[childIndex] ?? [] as checked, contentIndex}
                      {@const isBody = contentIndex === 0}
                      {@const content = isBody
                        ? child.issue.body
                        : child.comments[contentIndex - 1]?.body}
                      {#if hasContent(content)}
                        <div class="py-1">
                          <label class="flex items-center gap-2">
                            <Checkbox
                              bind:checked={childContentChecked[childIndex][contentIndex]}
                            />
                            <span class="text-sm">{getContentLabel(contentIndex, isBody)}</span>
                          </label>
                          <pre
                            class="plan-rendered-content mt-1 ml-6 line-clamp-10 text-xs whitespace-pre-wrap text-muted-foreground">{@html renderPlanContentHtml(
                              content?.trim() ?? ''
                            )}</pre>
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="flex items-center gap-3">
        <Button disabled={importing} onclick={handleImport}>
          {importing ? 'Importing...' : 'Import'}
        </Button>
        <Button variant="outline" disabled={importing} onclick={handleBack}>Back</Button>
        {#if importError}
          <p class="text-sm text-red-600 dark:text-red-400">{importError}</p>
        {/if}
      </div>
    </div>
  {/if}
</div>
