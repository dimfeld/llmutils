<script lang="ts">
  import UserPlus from '@lucide/svelte/icons/user-plus';
  import X from '@lucide/svelte/icons/x';
  import * as Command from '$lib/components/ui/command/index.js';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import {
    getAssignableReviewersForRepo,
    getRecentReviewersForRepo,
    requestPrReviewers,
  } from '$lib/remote/pr_status.remote.js';
  import { buildReviewerCandidates } from '$lib/utils/reviewer_candidates.js';
  import { extractRemoteErrorMessage } from '$lib/utils/remote_error.js';
  import { normalizeGitHubUsername } from '$common/github/username.js';

  let {
    owner,
    repo,
    prNumber,
    prUrl,
    exclude,
    onRequested,
    buttonClass = '',
  }: {
    owner: string;
    repo: string;
    prNumber: number;
    prUrl: string;
    /** Logins that cannot be requested, such as the PR author and current reviewers. */
    exclude: string[];
    onRequested?: (reviewers: string[]) => void;
    buttonClass?: string;
  } = $props();

  let open = $state(false);
  let search = $state('');
  let selected = $state<string[]>([]);
  let submitting = $state(false);
  let submitError = $state<string | null>(null);

  // Load the lists only while the popover is open.
  let recentResource = $derived(open ? getRecentReviewersForRepo({ owner, repo }) : null);
  let allResource = $derived(open ? getAssignableReviewersForRepo({ owner, repo }) : null);

  let candidates = $derived(
    buildReviewerCandidates({
      recent: recentResource?.current ?? [],
      all: allResource?.current ?? null,
      exclude,
      search,
    })
  );
  let selectedSet = $derived(new Set(selected.map((login) => normalizeGitHubUsername(login))));
  let allLoading = $derived(allResource?.loading ?? false);
  let allError = $derived(allResource?.error ? extractRemoteErrorMessage(allResource.error) : null);
  let recentError = $derived(
    recentResource?.error ? extractRemoteErrorMessage(recentResource.error) : null
  );
  let nothingToShow = $derived(
    candidates.recent.length === 0 && candidates.others.length === 0 && !candidates.typedLogin
  );

  function isSelected(login: string): boolean {
    return selectedSet.has(normalizeGitHubUsername(login));
  }

  function toggle(login: string): void {
    const normalized = normalizeGitHubUsername(login);
    if (selectedSet.has(normalized)) {
      selected = selected.filter((item) => normalizeGitHubUsername(item) !== normalized);
    } else {
      selected = [...selected, login];
    }
    submitError = null;
  }

  function handleOpenChange(isOpen: boolean): void {
    if (!isOpen && !submitting) {
      search = '';
      selected = [];
      submitError = null;
    }
  }

  async function submit(): Promise<void> {
    if (selected.length === 0 || submitting) {
      return;
    }

    submitting = true;
    submitError = null;
    const reviewers = [...selected];
    try {
      await requestPrReviewers({ owner, repo, prNumber, prUrl, reviewers });
      open = false;
      search = '';
      selected = [];
      onRequested?.(reviewers);
    } catch (err) {
      submitError = extractRemoteErrorMessage(err);
    } finally {
      submitting = false;
    }
  }
</script>

{#snippet reviewerItem(login: string)}
  <Command.Item
    value={login}
    onSelect={() => toggle(login)}
    data-checked={isSelected(login)}
    aria-selected={isSelected(login)}
    disabled={submitting}
  >
    <span class="min-w-0 flex-1 truncate">{login}</span>
  </Command.Item>
{/snippet}

<Popover.Root bind:open onOpenChange={handleOpenChange}>
  <Popover.Trigger
    class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800 {buttonClass}"
    title="Request reviews from one or more people"
  >
    <UserPlus class="size-3.5" />
    Request reviewers
  </Popover.Trigger>
  <Popover.Content class="w-72 p-0" align="start">
    <Command.Root shouldFilter={false} class="rounded-lg!">
      <Command.Input placeholder="Search people..." bind:value={search} />
      <Command.List class="max-h-64">
        {#if recentError}
          <div class="px-2 py-1.5 text-xs text-red-600 dark:text-red-400">{recentError}</div>
        {/if}
        {#if candidates.typedLogin}
          <Command.Group heading="Username">
            {@render reviewerItem(candidates.typedLogin)}
          </Command.Group>
        {/if}
        {#if candidates.recent.length > 0}
          <Command.Group heading="Recent reviewers">
            {#each candidates.recent as login (login)}
              {@render reviewerItem(login)}
            {/each}
          </Command.Group>
        {/if}
        {#if candidates.others.length > 0}
          <Command.Group heading="Everyone">
            {#each candidates.others as login (login)}
              {@render reviewerItem(login)}
            {/each}
          </Command.Group>
        {/if}
        {#if allLoading}
          <div class="px-2 py-1.5 text-xs text-muted-foreground">Loading people...</div>
        {:else if allError}
          <div class="flex items-center gap-2 px-2 py-1.5 text-xs text-red-600 dark:text-red-400">
            <span class="min-w-0 flex-1">{allError}</span>
            <button
              type="button"
              class="shrink-0 underline hover:no-underline"
              onclick={() => allResource?.refresh()}
            >
              Retry
            </button>
          </div>
        {:else if nothingToShow}
          <div class="px-2 py-4 text-center text-xs text-muted-foreground">
            {search.trim() ? 'No people match your search.' : 'No people found.'}
          </div>
        {/if}
      </Command.List>
    </Command.Root>
    <div class="space-y-2 border-t border-border p-2">
      {#if selected.length > 0}
        <div class="flex flex-wrap gap-1">
          {#each selected as login (login)}
            <span
              class="inline-flex items-center gap-1 rounded-md border border-border bg-accent/50 px-1.5 py-0.5 text-xs"
            >
              {login}
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground"
                aria-label="Remove {login}"
                disabled={submitting}
                onclick={() => toggle(login)}
              >
                <X class="size-3" />
              </button>
            </span>
          {/each}
        </div>
      {/if}
      {#if submitError}
        <p class="text-xs text-red-600 dark:text-red-400">{submitError}</p>
      {/if}
      <button
        type="button"
        class="w-full rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={selected.length === 0 || submitting}
        onclick={submit}
      >
        {#if submitting}
          Requesting...
        {:else if selected.length === 0}
          Select reviewers
        {:else}
          Request {selected.length} reviewer{selected.length === 1 ? '' : 's'}
        {/if}
      </button>
    </div>
  </Popover.Content>
</Popover.Root>
