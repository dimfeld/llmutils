<script lang="ts">
  import AppWindow from '@lucide/svelte/icons/app-window';
  import { toast } from 'svelte-sonner';

  import type { PlanDetail } from '$lib/server/db_queries.js';
  import { STATUS_ORDER_MAP } from '$lib/utils/plan_status.js';
  import { afterNavigate, invalidateAll } from '$app/navigation';
  import {
    startGenerate,
    startAgent,
    startChat,
    startRebase,
    startFinish,
    finishPlanQuick,
    openInEditor,
  } from '$lib/remote/plan_actions.remote.js';
  import {
    removeReviewIssue,
    convertReviewIssueToTask,
    clearReviewIssues,
  } from '$lib/remote/review_issue_actions.remote.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import StatusBadge from './StatusBadge.svelte';
  import PriorityBadge from './PriorityBadge.svelte';
  import PrStatusSection from './PrStatusSection.svelte';
  import { ButtonGroup } from '$lib/components/ui/button-group/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Collapsible from '$lib/components/ui/collapsible/index.js';

  let {
    plan,
    projectId,
    projectName,
    tab = 'plans',
    openInEditorEnabled = false,
  }: {
    plan: PlanDetail;
    projectId: string;
    projectName?: string;
    tab?: string;
    openInEditorEnabled?: boolean;
  } = $props();

  const sessionManager = useSessionManager();

  let openingTerminalPath: string | null = $state(null);
  let openingInEditor = $state(false);

  async function handleOpenInEditor() {
    if (openingInEditor) return;
    openingInEditor = true;
    try {
      await openInEditor({ planUuid: plan.uuid });
    } catch (err) {
      toast.error(`Failed to open in editor: ${(err as Error).message}`);
    } finally {
      openingInEditor = false;
    }
  }

  async function handleOpenTerminal(wsPath: string) {
    if (openingTerminalPath) return;
    openingTerminalPath = wsPath;
    try {
      await sessionManager.openTerminalInDirectory(wsPath);
    } catch (err) {
      toast.error(`Failed to open terminal: ${(err as Error).message}`);
    } finally {
      openingTerminalPath = null;
    }
  }

  const INELIGIBLE_STATUSES = new Set([
    'done',
    'needs_review',
    'cancelled',
    'deferred',
    'recently_done',
  ]);

  let isIneligible = $derived(INELIGIBLE_STATUSES.has(plan.displayStatus));
  let hasTasks = $derived(plan.tasks.length > 0);
  let hasIncompleteTasks = $derived(plan.taskCounts.done < plan.taskCounts.total);
  let tasksOpen = $derived(plan.taskCounts.done < plan.taskCounts.total);
  let isBlocked = $derived(plan.displayStatus === 'blocked');

  // needs_review plans: show "Finish" as primary button
  let showFinish = $derived(plan.displayStatus === 'needs_review');
  // done plans with pending finalization work: show "Finish" in dropdown
  let hasPendingFinalizationWork = $derived(
    plan.docsUpdatedAt === null || plan.lessonsAppliedAt === null
  );
  let showFinishInDropdown = $derived(plan.displayStatus === 'done' && hasPendingFinalizationWork);

  // Plans with incomplete tasks: show single "Run Agent" button
  let showAgentOnly = $derived(hasTasks && hasIncompleteTasks && !isIneligible && !showFinish);
  // Plans without tasks: show "Generate" as primary + "Run Agent" in dropdown
  let showGenerateWithAgent = $derived(!hasTasks && !isIneligible && !showFinish);
  // All tasks complete or terminal status: show standalone Chat button
  let showChatOnly = $derived(!showGenerateWithAgent && !showAgentOnly && !showFinish);

  // Active session detection is independent of eligibility so the "Running" link
  // remains visible even if the plan transitions to an ineligible status.
  // Matches any active session on the plan (command-agnostic), consistent with
  // server-side duplicate prevention.
  let activeSession = $derived.by(() => {
    for (const session of sessionManager.sessions.values()) {
      if (session.status === 'active' && session.sessionInfo.planUuid === plan.uuid) {
        return {
          connectionId: session.connectionId,
          command: session.sessionInfo.command,
        };
      }
    }
    return null;
  });

  const REBASE_ELIGIBLE_STATUSES = new Set(['in_progress', 'needs_review', 'done']);
  let isEligibleForRebase = $derived(REBASE_ELIGIBLE_STATUSES.has(plan.status));

  let startingGenerate = $state(false);
  let startingAgent = $state(false);
  let startingRebase = $state(false);
  let startingChat: 'claude' | 'codex' | false = $state(false);
  let startingFinish = $state(false);
  let chatDialogOpen = $state(false);
  let startedSuccessfully = $state(false);
  let errorMessage: string | null = $state(null);
  let successMessage: { text: string; connectionId?: string } | null = $state(null);
  let reviewIssueSubmitting: number | 'clear' | null = $state(null);

  async function handleRemoveReviewIssue(index: number) {
    if (reviewIssueSubmitting !== null) return;
    reviewIssueSubmitting = index;
    try {
      await removeReviewIssue({ planUuid: plan.uuid, issueIndex: index });
      await invalidateAll();
    } catch (err) {
      toast.error(`Failed to remove issue: ${(err as Error).message}`);
    } finally {
      reviewIssueSubmitting = null;
    }
  }

  async function handleConvertToTask(index: number) {
    if (reviewIssueSubmitting !== null) return;
    reviewIssueSubmitting = index;
    try {
      await convertReviewIssueToTask({ planUuid: plan.uuid, issueIndex: index });
      await invalidateAll();
    } catch (err) {
      toast.error(`Failed to convert issue to task: ${(err as Error).message}`);
    } finally {
      reviewIssueSubmitting = null;
    }
  }

  async function handleClearReviewIssues() {
    if (reviewIssueSubmitting !== null) return;
    if (!confirm('Clear all review issues? This cannot be undone.')) return;
    reviewIssueSubmitting = 'clear';
    try {
      await clearReviewIssues({ planUuid: plan.uuid });
      await invalidateAll();
    } catch (err) {
      toast.error(`Failed to clear issues: ${(err as Error).message}`);
    } finally {
      reviewIssueSubmitting = null;
    }
  }

  afterNavigate(({ from, to }) => {
    if (from && to && from.url.pathname !== to.url.pathname) {
      startingGenerate = false;
      startingAgent = false;
      startingRebase = false;
      startingChat = false;
      startingFinish = false;
      chatDialogOpen = false;
      startedSuccessfully = false;
      reviewIssueSubmitting = null;
      clearStartedTimeout();
      errorMessage = null;
      successMessage = null;
    }
  });

  let startedSuccessfullyTimeout: ReturnType<typeof setTimeout> | null = null;

  function clearStartedTimeout() {
    if (startedSuccessfullyTimeout) {
      clearTimeout(startedSuccessfullyTimeout);
      startedSuccessfullyTimeout = null;
    }
  }

  $effect(() => {
    if (activeSession) {
      startedSuccessfully = false;
      clearStartedTimeout();
    }
    return () => clearStartedTimeout();
  });

  function setStartedSuccessfully() {
    startedSuccessfully = true;
    if (startedSuccessfullyTimeout) {
      clearTimeout(startedSuccessfullyTimeout);
    }
    startedSuccessfullyTimeout = setTimeout(() => {
      startedSuccessfully = false;
      startedSuccessfullyTimeout = null;
    }, 30_000);
  }

  async function handleGenerate() {
    startingGenerate = true;
    errorMessage = null;
    successMessage = null;
    try {
      const result = await startGenerate({ planUuid: plan.uuid });
      if (result.status === 'already_running') {
        successMessage = {
          text: 'A session is already running for this plan',
          connectionId: result.connectionId,
        };
      } else {
        successMessage = { text: 'Generate started' };
      }
      setStartedSuccessfully();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingGenerate = false;
    }
  }

  let starting = $derived(
    startingGenerate || startingAgent || startingRebase || startingChat || startingFinish
  );
  let controlsDisabled = $derived(starting || startedSuccessfully);

  async function handleRunAgent() {
    if (isBlocked && !confirm('This plan has unresolved dependencies. Run agent anyway?')) {
      return;
    }
    startingAgent = true;
    errorMessage = null;
    successMessage = null;
    try {
      const result = await startAgent({ planUuid: plan.uuid });
      if (result.status === 'already_running') {
        successMessage = {
          text: 'A session is already running for this plan',
          connectionId: result.connectionId,
        };
      } else {
        successMessage = { text: 'Agent started' };
      }
      setStartedSuccessfully();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingAgent = false;
    }
  }

  async function handleRebase() {
    startingRebase = true;
    errorMessage = null;
    successMessage = null;
    try {
      const result = await startRebase({ planUuid: plan.uuid });
      if (result.status === 'already_running') {
        successMessage = {
          text: 'A session is already running for this plan',
          connectionId: result.connectionId,
        };
      } else {
        successMessage = { text: 'Rebase started' };
      }
      setStartedSuccessfully();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingRebase = false;
    }
  }

  async function handleChat(executor: 'claude' | 'codex') {
    startingChat = executor;
    errorMessage = null;
    successMessage = null;
    try {
      const result = await startChat({ planUuid: plan.uuid, executor });
      if (result.status === 'already_running') {
        successMessage = {
          text: 'A session is already running for this plan',
          connectionId: result.connectionId,
        };
      } else {
        successMessage = { text: 'Chat started' };
      }
      setStartedSuccessfully();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingChat = false;
      chatDialogOpen = false;
    }
  }

  async function handleFinish() {
    startingFinish = true;
    errorMessage = null;
    successMessage = null;
    try {
      const result = await startFinish({ planUuid: plan.uuid });
      if (result.status === 'already_running') {
        successMessage = {
          text: 'A session is already running for this plan',
          connectionId: result.connectionId,
        };
      } else {
        successMessage = { text: 'Finish started' };
      }
      setStartedSuccessfully();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingFinish = false;
    }
  }

  async function handleFinishQuick() {
    startingFinish = true;
    errorMessage = null;
    successMessage = null;
    try {
      await finishPlanQuick({ planUuid: plan.uuid });
      successMessage = { text: 'Plan marked as done' };
      setStartedSuccessfully();
      await invalidateAll();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingFinish = false;
    }
  }

  let sortedDependencies = $derived(
    [...plan.dependencies].sort((a, b) => {
      const aOrder = a.displayStatus ? (STATUS_ORDER_MAP[a.displayStatus] ?? 99) : 99;
      const bOrder = b.displayStatus ? (STATUS_ORDER_MAP[b.displayStatus] ?? 99) : 99;
      return aOrder - bOrder;
    })
  );

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

  let copiedId: string | null = $state(null);

  async function copyToClipboard(text: string, id: string) {
    await navigator.clipboard.writeText(text);
    copiedId = id;
    setTimeout(() => {
      if (copiedId === id) copiedId = null;
    }, 1500);
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

      {#if activeSession}
        <a
          href="/projects/{projectId}/sessions/{activeSession.connectionId}"
          class="ml-auto inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium transition-colors
            {activeSession.command === 'agent'
            ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:hover:bg-emerald-900/60'
            : activeSession.command === 'chat'
              ? 'bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:hover:bg-violet-900/60'
              : 'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:hover:bg-blue-900/60'}"
        >
          <span
            class="inline-block h-2 w-2 animate-pulse rounded-full {activeSession.command ===
            'agent'
              ? 'bg-emerald-500'
              : activeSession.command === 'chat'
                ? 'bg-violet-500'
                : 'bg-blue-500'}"
          ></span>
          {activeSession.command === 'agent'
            ? 'Agent Running…'
            : activeSession.command === 'generate'
              ? 'Generating…'
              : `${activeSession.command.charAt(0).toUpperCase() + activeSession.command.slice(1)} Running…`}
        </a>
      {:else if showFinish}
        <ButtonGroup class="ml-auto">
          <Button
            onclick={handleFinish}
            disabled={controlsDisabled}
            size="sm"
            class="bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
          >
            {#if startingFinish}
              <span
                class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"
              ></span>
              Starting…
            {:else}
              Finish
            {/if}
          </Button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button
                  {...props}
                  disabled={controlsDisabled}
                  size="icon-sm"
                  aria-label="More plan actions"
                  class="bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item onclick={() => (chatDialogOpen = true)}>Chat</DropdownMenu.Item>
              {#if openInEditorEnabled}
                <DropdownMenu.Item onclick={handleOpenInEditor} disabled={openingInEditor}>
                  {openingInEditor ? 'Opening…' : 'Open in Editor'}
                </DropdownMenu.Item>
              {/if}
              {#if isEligibleForRebase}
                <DropdownMenu.Item onclick={handleRebase} disabled={controlsDisabled}>
                  {startingRebase ? 'Starting Rebase…' : 'Rebase'}
                </DropdownMenu.Item>
              {/if}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </ButtonGroup>
      {:else if showAgentOnly}
        <ButtonGroup class="ml-auto">
          <Button
            onclick={handleRunAgent}
            disabled={controlsDisabled}
            size="sm"
            class="bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600"
          >
            {#if startingAgent}
              <span
                class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"
              ></span>
              Starting…
            {:else}
              Run Agent
            {/if}
          </Button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button
                  {...props}
                  disabled={controlsDisabled}
                  size="icon-sm"
                  aria-label="More plan actions"
                  class="bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item onclick={() => (chatDialogOpen = true)}>Chat</DropdownMenu.Item>
              {#if openInEditorEnabled}
                <DropdownMenu.Item onclick={handleOpenInEditor} disabled={openingInEditor}>
                  {openingInEditor ? 'Opening…' : 'Open in Editor'}
                </DropdownMenu.Item>
              {/if}
              {#if isEligibleForRebase}
                <DropdownMenu.Item onclick={handleRebase} disabled={controlsDisabled}>
                  {startingRebase ? 'Starting Rebase…' : 'Rebase'}
                </DropdownMenu.Item>
              {/if}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </ButtonGroup>
      {:else if showGenerateWithAgent}
        <ButtonGroup class="ml-auto">
          <Button
            onclick={handleGenerate}
            disabled={controlsDisabled}
            size="sm"
            class="bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
          >
            {#if startingGenerate}
              <span
                class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"
              ></span>
              Starting…
            {:else}
              Generate
            {/if}
          </Button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button
                  {...props}
                  disabled={controlsDisabled}
                  size="icon-sm"
                  aria-label="More plan actions"
                  class="bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item onclick={handleRunAgent}>Run Agent</DropdownMenu.Item>
              <DropdownMenu.Item onclick={() => (chatDialogOpen = true)}>Chat</DropdownMenu.Item>
              {#if openInEditorEnabled}
                <DropdownMenu.Item onclick={handleOpenInEditor} disabled={openingInEditor}>
                  {openingInEditor ? 'Opening…' : 'Open in Editor'}
                </DropdownMenu.Item>
              {/if}
              {#if isEligibleForRebase}
                <DropdownMenu.Item onclick={handleRebase} disabled={controlsDisabled}>
                  {startingRebase ? 'Starting Rebase…' : 'Rebase'}
                </DropdownMenu.Item>
              {/if}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </ButtonGroup>
      {:else if showChatOnly}
        <div class="ml-auto flex items-center gap-2">
          {#if openInEditorEnabled}
            <Button
              onclick={handleOpenInEditor}
              disabled={openingInEditor}
              size="sm"
              variant="outline"
            >
              {openingInEditor ? 'Opening…' : 'Open in Editor'}
            </Button>
          {/if}
          {#if isEligibleForRebase}
            <ButtonGroup>
              <Button
                onclick={() => (chatDialogOpen = true)}
                disabled={controlsDisabled}
                size="sm"
                class="bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600"
              >
                {#if startingChat}
                  <span
                    class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"
                  ></span>
                  Starting…
                {:else}
                  Chat
                {/if}
              </Button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <Button
                      {...props}
                      disabled={controlsDisabled}
                      size="icon-sm"
                      aria-label="More plan actions"
                      class="bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </Button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  <DropdownMenu.Item onclick={handleRebase} disabled={controlsDisabled}>
                    {startingRebase ? 'Starting Rebase…' : 'Rebase'}
                  </DropdownMenu.Item>
                  {#if showFinishInDropdown}
                    <DropdownMenu.Item onclick={handleFinish} disabled={controlsDisabled}>
                      {startingFinish ? 'Starting Finish…' : 'Finish'}
                    </DropdownMenu.Item>
                  {/if}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </ButtonGroup>
          {:else if showFinishInDropdown}
            <ButtonGroup>
              <Button
                onclick={() => (chatDialogOpen = true)}
                disabled={controlsDisabled}
                size="sm"
                class="bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600"
              >
                {#if startingChat}
                  <span
                    class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"
                  ></span>
                  Starting…
                {:else}
                  Chat
                {/if}
              </Button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <Button
                      {...props}
                      disabled={controlsDisabled}
                      size="icon-sm"
                      aria-label="More plan actions"
                      class="bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </Button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  <DropdownMenu.Item onclick={handleFinish} disabled={controlsDisabled}>
                    {startingFinish ? 'Starting Finish…' : 'Finish'}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </ButtonGroup>
          {:else}
            <Button
              onclick={() => (chatDialogOpen = true)}
              disabled={controlsDisabled}
              size="sm"
              class="bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600"
            >
              {#if startingChat}
                <span
                  class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"
                ></span>
                Starting…
              {:else}
                Chat
              {/if}
            </Button>
          {/if}
        </div>
      {/if}
      {#if openInEditorEnabled && activeSession}
        <Button onclick={handleOpenInEditor} disabled={openingInEditor} size="sm" variant="outline">
          {openingInEditor ? 'Opening…' : 'Open in Editor'}
        </Button>
      {/if}
    </div>

    {#if errorMessage}
      <div
        class="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300"
      >
        {errorMessage}
      </div>
    {/if}

    {#if successMessage && !activeSession}
      <div
        class="mt-2 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-900/30 dark:text-green-300"
      >
        {successMessage.text}
        {#if successMessage.connectionId}
          — <a
            href="/projects/{projectId}/sessions/{successMessage.connectionId}"
            class="underline hover:no-underline">View session</a
          >
        {/if}
      </div>
    {/if}
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
    <Collapsible.Root bind:open={tasksOpen}>
      <Collapsible.Trigger
        class="flex w-full cursor-pointer items-center justify-between rounded px-0 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Toggle tasks"
      >
        <h3 class="text-xs font-semibold tracking-wide uppercase">
          Tasks ({plan.taskCounts.done}/{plan.taskCounts.total})
        </h3>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="transition-transform {tasksOpen ? 'rotate-180' : ''}"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <ul class="mt-2 space-y-1.5">
          {#each plan.tasks as task (task.id)}
            {@const taskCopyId = `task-${task.id}`}
            {@const taskCopyText = task.description
              ? `${task.title}\n\n${task.description}`
              : task.title}
            <li class="group flex items-start gap-2 text-sm">
              <span class="mt-0.5 shrink-0">
                {#if task.done}
                  <span class="text-green-600 dark:text-green-400">✓</span>
                {:else}
                  <span class="text-gray-300 dark:text-gray-500">○</span>
                {/if}
              </span>
              <div class="min-w-0 flex-1">
                <span class={task.done ? 'text-muted-foreground' : 'text-foreground'}>
                  {task.title}
                </span>
                {#if task.description}
                  <p class="mt-0.5 text-xs text-muted-foreground">{task.description}</p>
                {/if}
              </div>
              <button
                type="button"
                onclick={() => copyToClipboard(taskCopyText, taskCopyId)}
                class="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800 {copiedId ===
                taskCopyId
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100'}"
                aria-label="Copy task"
                title="Copy task"
              >
                {#if copiedId === taskCopyId}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="text-green-600 dark:text-green-400"
                    ><polyline points="20 6 9 17 4 12" /></svg
                  >
                {:else}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    ><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path
                      d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
                    /></svg
                  >
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      </Collapsible.Content>
    </Collapsible.Root>
  {/if}

  <!-- Dependencies -->
  {#if plan.dependencies.length > 0}
    <div>
      <h3 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Dependencies
      </h3>
      <ul class="space-y-1">
        {#each sortedDependencies as dep (dep.uuid)}
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
          <div class="flex items-center gap-1">
            <div class="min-w-0 truncate">{wsPath}</div>
            <button
              type="button"
              class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
              onclick={() => handleOpenTerminal(wsPath)}
              disabled={openingTerminalPath !== null}
              aria-label="Open new terminal"
              title="Open new terminal"
            >
              <AppWindow class="size-3.5" />
            </button>
          </div>
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
    <PrStatusSection planUuid={plan.uuid} />
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

  <!-- Review Issues -->
  {#if plan.reviewIssues && plan.reviewIssues.length > 0}
    <div>
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Review Issues ({plan.reviewIssues.length})
        </h3>
        <button
          type="button"
          onclick={handleClearReviewIssues}
          disabled={reviewIssueSubmitting !== null}
          class="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-red-100 hover:text-red-700 disabled:opacity-50 dark:hover:bg-red-950/50 dark:hover:text-red-400"
        >
          {reviewIssueSubmitting === 'clear' ? 'Clearing...' : 'Clear All'}
        </button>
      </div>
      <ul class="space-y-2">
        {#each plan.reviewIssues as issue, i (i)}
          {@const severityClass =
            issue.severity === 'critical'
              ? 'border-red-500 bg-red-50 dark:bg-red-950/30'
              : issue.severity === 'major'
                ? 'border-orange-400 bg-orange-50 dark:bg-orange-950/30'
                : issue.severity === 'minor'
                  ? 'border-yellow-400 bg-yellow-50 dark:bg-yellow-950/30'
                  : 'border-gray-300 bg-gray-50 dark:bg-gray-800/30'}
          {@const severityTextClass =
            issue.severity === 'critical'
              ? 'text-red-700 dark:text-red-400'
              : issue.severity === 'major'
                ? 'text-orange-700 dark:text-orange-400'
                : issue.severity === 'minor'
                  ? 'text-yellow-700 dark:text-yellow-400'
                  : 'text-gray-500 dark:text-gray-400'}
          {@const issueCopyId = `issue-${i}`}
          {@const issueCopyText = [
            issue.file ? `${issue.file}${issue.line !== undefined ? `:${issue.line}` : ''}` : null,
            issue.content,
            issue.suggestion ? `Suggestion: ${issue.suggestion}` : null,
          ]
            .filter(Boolean)
            .join('\n\n')}
          <li class="group rounded border-l-2 px-3 py-2 text-sm {severityClass}">
            <div class="flex items-center gap-2">
              <span class="font-medium {severityTextClass}">{issue.severity}</span>
              <span class="text-muted-foreground">·</span>
              <span class="font-medium text-foreground">{issue.category}</span>
              {#if issue.source}
                <span
                  class="rounded bg-purple-100 px-1 py-0.5 text-xs text-purple-700 dark:bg-purple-950/50 dark:text-purple-400"
                >
                  {issue.source === 'claude-code' ? 'Claude' : 'Codex'}
                </span>
              {/if}
              {#if issue.file}
                <span class="font-mono text-xs text-muted-foreground">
                  {issue.file}{issue.line !== undefined ? `:${issue.line}` : ''}
                </span>
              {/if}
              <div class="ml-auto flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onclick={() => handleConvertToTask(i)}
                  disabled={reviewIssueSubmitting !== null}
                  class="rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-blue-100 hover:text-blue-700 disabled:opacity-50 dark:hover:bg-blue-950/50 dark:hover:text-blue-400"
                  aria-label="Convert to task"
                  title="Convert to task"
                >
                  {reviewIssueSubmitting === i ? '...' : '→ Task'}
                </button>
                <button
                  type="button"
                  onclick={() => copyToClipboard(issueCopyText, issueCopyId)}
                  class="rounded p-0.5 text-muted-foreground transition-opacity hover:bg-black/10 hover:text-foreground dark:hover:bg-white/10 {copiedId ===
                  issueCopyId
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100'}"
                  aria-label="Copy issue"
                  title="Copy issue"
                >
                  {#if copiedId === issueCopyId}
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      class="text-green-600 dark:text-green-400"
                      ><polyline points="20 6 9 17 4 12" /></svg
                    >
                  {:else}
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      ><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path
                        d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
                      /></svg
                    >
                  {/if}
                </button>
                <button
                  type="button"
                  onclick={() => handleRemoveReviewIssue(i)}
                  disabled={reviewIssueSubmitting !== null}
                  class="rounded p-0.5 text-muted-foreground hover:bg-red-100 hover:text-red-700 disabled:opacity-50 dark:hover:bg-red-950/50 dark:hover:text-red-400"
                  aria-label="Dismiss issue"
                  title="Dismiss issue"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg
                  >
                </button>
              </div>
            </div>
            <p class="mt-1 text-foreground">{issue.content}</p>
            {#if issue.suggestion}
              <p class="mt-1 text-xs text-muted-foreground">
                <span class="font-medium text-green-700 dark:text-green-400">Suggestion:</span>
                {issue.suggestion}
              </p>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- Details -->
  {#if plan.details}
    <div>
      <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Details
      </h3>
      <p class="text-sm whitespace-pre-wrap text-foreground">{plan.details}</p>
    </div>
  {/if}

  <!-- Timestamps -->
  <div class="space-y-1 text-xs text-muted-foreground">
    <div>Created: {formatDate(plan.createdAt)}</div>
    <div>Updated: {formatDate(plan.updatedAt)}</div>
  </div>
</div>

<Dialog.Root
  open={chatDialogOpen}
  onOpenChange={(open) => {
    if (!open && startingChat) return;
    chatDialogOpen = open;
  }}
>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Start Chat Session</Dialog.Title>
      <Dialog.Description>Choose which AI assistant to use</Dialog.Description>
    </Dialog.Header>
    <div class="flex gap-3 py-4">
      <Button
        onclick={() => handleChat('claude')}
        class="flex-1 bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
        disabled={!!startingChat}
      >
        {#if startingChat === 'claude'}
          <span
            class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"
          ></span>
          Starting…
        {:else}
          Claude
        {/if}
      </Button>
      <Button
        onclick={() => handleChat('codex')}
        class="flex-1 bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600"
        disabled={!!startingChat}
      >
        {#if startingChat === 'codex'}
          <span
            class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"
          ></span>
          Starting…
        {:else}
          Codex
        {/if}
      </Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
