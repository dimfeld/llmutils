<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { toast } from 'svelte-sonner';
  import { buildLinearReviewDeepLink } from '$lib/utils/linear_review_deep_link.js';
  import {
    fullRefreshPrStatus,
    getPrStatus,
    refreshPrStatus,
    requestTimReviewLabel,
    togglePrDraftStatus,
  } from '$lib/remote/pr_status.remote.js';
  import { REVIEW_LABEL_NAME } from '$common/github/review_command.js';
  import { isPrRebaseEligible } from '$lib/utils/pr_rebase_eligibility.js';
  import type { PrStatusRow } from '$tim/db/pr_status.js';
  import {
    startFixThreads,
    startCiFix,
    startPrAutoreview,
    startPrRebase,
  } from '$lib/remote/review_thread_actions.remote.js';
  import {
    getFixButtonState,
    getFixStartResultState,
  } from '$lib/components/pr_fix_launch_state.js';
  import { normalizeGitHubUsername } from '$common/github/username.js';
  import { getEffectiveReviewDecision } from '$common/github/review_requests.js';
  import { canFixCi } from '$lib/utils/ci_fix_eligibility.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { hasRelevantPrUpdate } from '$lib/utils/pr_update_events.js';
  import {
    stateBadgeColor,
    stateLabel,
    checksBadgeColor,
    checksLabel,
    labelStyle,
    reviewDecisionBadgeColor,
    reviewDecisionLabel,
  } from '$lib/utils/pr_display.js';

  import CopyButton from './CopyButton.svelte';
  import PrMergeQueueBadge from './PrMergeQueueBadge.svelte';
  import ExecutorChoiceDropdown from './ExecutorChoiceDropdown.svelte';
  import ActiveSessionLink from './ActiveSessionLink.svelte';
  import type { ChatExecutorOption } from '$tim/configSchema.js';
  import { DEFAULT_CHAT_EXECUTOR_OPTIONS } from '$lib/utils/chat_executor_options.js';
  import PrCheckRunList from './PrCheckRunList.svelte';
  import PrReviewList from './PrReviewList.svelte';
  import PrReviewThreadList from './PrReviewThreadList.svelte';

  let {
    planUuid,
    projectId,
    prFixExecutorOptions = DEFAULT_CHAT_EXECUTOR_OPTIONS,
  }: {
    planUuid: string;
    projectId: string;
    prFixExecutorOptions?: ChatExecutorOption[];
  } = $props();
  const sessionManager = useSessionManager();

  let prData = $derived(await getPrStatus({ planUuid }));
  let prUrls = $derived(prData.prUrls);
  let invalidPrUrls = $derived(prData.invalidPrUrls);
  let tokenConfigured = $derived(prData.tokenConfigured);
  let statusByUrl = $derived(new Map(prData.prStatuses.map((pr) => [pr.status.pr_url, pr])));
  let latestReviewGuidesByPrUrl = $derived(prData.latestReviewGuidesByPrUrl);
  function isVisiblePrStatus(status: PrStatusRow): boolean {
    return status.state !== 'closed' || status.merged_at !== null;
  }

  type PullRequestWithBranches = {
    status: Pick<PrStatusRow, 'owner' | 'repo' | 'head_branch' | 'base_branch'>;
  };

  function branchKey(
    status: Pick<PrStatusRow, 'owner' | 'repo' | 'head_branch' | 'base_branch'>,
    branch: string
  ): string {
    return `${status.owner.toLowerCase()}/${status.repo.toLowerCase()}:${branch}`;
  }

  function sortPullRequestsInStackOrder<T extends PullRequestWithBranches>(pullRequests: T[]): T[] {
    const headBranchIndexes = new Map<string, number[]>();
    for (const [index, pullRequest] of pullRequests.entries()) {
      const headBranch = pullRequest.status.head_branch;
      if (!headBranch) continue;

      const key = branchKey(pullRequest.status, headBranch);
      const indexes = headBranchIndexes.get(key) ?? [];
      indexes.push(index);
      headBranchIndexes.set(key, indexes);
    }

    const childIndexes = new Map<number, number[]>();
    const remainingDependencies = new Array(pullRequests.length).fill(0);
    for (const [index, pullRequest] of pullRequests.entries()) {
      const baseBranch = pullRequest.status.base_branch;
      if (!baseBranch) continue;

      const parentIndexes = headBranchIndexes.get(branchKey(pullRequest.status, baseBranch)) ?? [];
      for (const parentIndex of parentIndexes) {
        if (parentIndex === index) continue;

        const children = childIndexes.get(parentIndex) ?? [];
        children.push(index);
        childIndexes.set(parentIndex, children);
        remainingDependencies[index] += 1;
      }
    }

    const readyIndexes = pullRequests.reduce<number[]>((indexes, _pullRequest, index) => {
      if (remainingDependencies[index] === 0) indexes.push(index);
      return indexes;
    }, []);
    const sortedIndexes: number[] = [];

    while (readyIndexes.length > 0) {
      readyIndexes.sort((left, right) => left - right);
      const index = readyIndexes.shift();
      if (index === undefined) break;

      sortedIndexes.push(index);
      for (const childIndex of childIndexes.get(index) ?? []) {
        remainingDependencies[childIndex] -= 1;
        if (remainingDependencies[childIndex] === 0) readyIndexes.push(childIndex);
      }
    }

    if (sortedIndexes.length < pullRequests.length) {
      const sortedIndexSet = new Set(sortedIndexes);
      for (const [index] of pullRequests.entries()) {
        if (!sortedIndexSet.has(index)) sortedIndexes.push(index);
      }
    }

    return sortedIndexes.map((index) => pullRequests[index]);
  }

  function getStackedOnPullRequest<T extends PullRequestWithBranches>(
    pullRequest: T,
    pullRequests: T[]
  ): T | undefined {
    const baseBranch = pullRequest.status.base_branch;
    if (!baseBranch) return undefined;

    const baseKey = branchKey(pullRequest.status, baseBranch);
    return pullRequests.find(
      (candidate) =>
        candidate !== pullRequest &&
        candidate.status.head_branch !== null &&
        branchKey(candidate.status, candidate.status.head_branch) === baseKey
    );
  }

  function getExternalPrUrl(pr: { status: PrStatusRow }): string {
    return (
      buildLinearReviewDeepLink({
        prUrl: pr.status.pr_url,
        prNumber: pr.status.pr_number,
      }) ?? pr.status.pr_url
    );
  }

  let effectivePrs = $derived(
    sortPullRequestsInStackOrder(prData.prStatuses.filter((pr) => isVisiblePrStatus(pr.status)))
  );
  let uncachedUrls = $derived(prUrls.filter((url) => !statusByUrl.has(url)));

  let hasUnresolvedThreads = $derived(
    effectivePrs.some((pr) => pr.reviewThreads?.some((rt) => !rt.thread.is_resolved)) ?? false
  );

  let hasFailingOwnPr = $derived(
    effectivePrs.some((pr) => canFixCi({ isOwnPr: isOwnPr(pr.status), status: pr.status }))
  );

  let activeSessionIdForPlan = $derived.by(() => {
    for (const session of sessionManager.sessions.values()) {
      if (session.status === 'active' && session.sessionInfo.planUuid === planUuid) {
        return session.connectionId;
      }
    }
    return null;
  });

  let ciFixActiveSessionIdForPlan = $derived.by(() => {
    for (const session of sessionManager.sessions.values()) {
      if (
        session.status === 'active' &&
        session.sessionInfo.planUuid === planUuid &&
        session.sessionInfo.command === 'ci-fix'
      ) {
        return session.connectionId;
      }
    }
    return null;
  });
  let sessionActiveForPlan = $derived(activeSessionIdForPlan !== null);
  let ciFixSessionActiveForPlan = $derived(ciFixActiveSessionIdForPlan !== null);

  let refreshError = $state<string | null>(null);
  const autoreviewStarting = new SvelteSet<string>();
  const draftUpdating = new SvelteSet<string>();
  const timReviewRequesting = new SvelteSet<string>();
  const rebaseStarting = new SvelteSet<string>();
  // PR URL -> launch timestamp, for the gap until the rebase session shows up.
  const rebaseLaunched = new SvelteMap<string, number>();

  function isOwnPr(status: PrStatusRow): boolean {
    const configuredUsername = prData.configuredUsername;
    return (
      !!configuredUsername &&
      !!status.author &&
      normalizeGitHubUsername(status.author) === normalizeGitHubUsername(configuredUsername)
    );
  }

  function hasTimReviewLabel(pr: { labels: { name: string }[] }): boolean {
    return pr.labels.some((label) => label.name.toLowerCase() === REVIEW_LABEL_NAME);
  }

  function getRebaseActiveSessionId(status: PrStatusRow): string | null {
    const result = sessionManager.hasActiveSessionForPr(status.pr_url, 'pr-rebase');
    return result.active ? (result.connectionId ?? '') : null;
  }

  $effect(() => {
    for (const prUrl of rebaseLaunched.keys()) {
      if (sessionManager.hasActiveSessionForPr(prUrl, 'pr-rebase').active) {
        rebaseLaunched.delete(prUrl);
      }
    }
  });

  $effect(() => {
    if (rebaseLaunched.size === 0) return;
    const timer = setTimeout(() => {
      const cutoff = Date.now() - 30_000;
      for (const [prUrl, launchedAt] of rebaseLaunched) {
        if (launchedAt <= cutoff) rebaseLaunched.delete(prUrl);
      }
    }, 30_000);
    return () => clearTimeout(timer);
  });

  async function handleToggleDraftStatus(pr: PrStatusRow): Promise<void> {
    if (draftUpdating.has(pr.pr_url)) return;

    const requestPlanUuid = planUuid;
    draftUpdating.add(pr.pr_url);
    refreshError = null;
    try {
      await togglePrDraftStatus({
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.pr_number,
        prUrl: pr.pr_url,
        draft: !pr.draft,
      });
      if (planUuid !== requestPlanUuid) return;
      toast.success(
        pr.draft
          ? `PR #${pr.pr_number} marked ready for review`
          : `PR #${pr.pr_number} converted to draft`
      );
      getPrStatus({ planUuid }).refresh();
    } catch (err) {
      if (planUuid !== requestPlanUuid) return;
      refreshError = `Failed to update PR #${pr.pr_number}: ${err}`;
    } finally {
      draftUpdating.delete(pr.pr_url);
    }
  }

  async function handleRequestTimReview(pr: PrStatusRow): Promise<void> {
    if (timReviewRequesting.has(pr.pr_url)) return;

    const requestPlanUuid = planUuid;
    timReviewRequesting.add(pr.pr_url);
    refreshError = null;
    try {
      await requestTimReviewLabel({
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.pr_number,
        prUrl: pr.pr_url,
      });
      if (planUuid !== requestPlanUuid) return;
      toast.success(`tim review requested for PR #${pr.pr_number}`);
      getPrStatus({ planUuid }).refresh();
    } catch (err) {
      if (planUuid !== requestPlanUuid) return;
      refreshError = `Failed to request tim review for PR #${pr.pr_number}: ${err}`;
    } finally {
      timReviewRequesting.delete(pr.pr_url);
    }
  }

  async function handleStartRebase(pr: PrStatusRow): Promise<void> {
    if (
      rebaseStarting.has(pr.pr_url) ||
      rebaseLaunched.has(pr.pr_url) ||
      getRebaseActiveSessionId(pr) !== null
    ) {
      return;
    }

    const requestPlanUuid = planUuid;
    rebaseStarting.add(pr.pr_url);
    refreshError = null;
    try {
      const result = await startPrRebase({
        projectId: Number(projectId),
        prNumber: pr.pr_number,
      });
      if (planUuid !== requestPlanUuid) return;
      const fixResultState = getFixStartResultState(result.status, 'pr');
      if (fixResultState.fixLaunched) {
        rebaseLaunched.set(pr.pr_url, Date.now());
        toast.success(`Conflict fix started for PR #${pr.pr_number}`);
      }
      refreshError = fixResultState.message;
    } catch (err) {
      if (planUuid !== requestPlanUuid) return;
      refreshError = `Failed to start conflict fix for PR #${pr.pr_number}: ${err}`;
    } finally {
      rebaseStarting.delete(pr.pr_url);
    }
  }

  async function handleStartAutoreview(pr: PrStatusRow): Promise<void> {
    if (
      autoreviewStarting.has(pr.pr_url) ||
      sessionManager.hasActiveSessionForPr(pr.pr_url).active
    ) {
      return;
    }

    const requestPlanUuid = planUuid;
    autoreviewStarting.add(pr.pr_url);
    refreshError = null;
    try {
      const result = await startPrAutoreview({
        projectId: Number(projectId),
        prNumber: pr.pr_number,
      });
      if (planUuid !== requestPlanUuid) return;
      if (result.status === 'already_running') {
        refreshError = `A session is already running for PR #${pr.pr_number}`;
      } else {
        toast.success(`Autoreview started for PR #${pr.pr_number}`);
      }
    } catch (err) {
      if (planUuid !== requestPlanUuid) return;
      refreshError = `Failed to start autoreview for PR #${pr.pr_number}: ${err}`;
    } finally {
      autoreviewStarting.delete(pr.pr_url);
    }
  }
  let refreshing = $state(false);
  let fixStarting = $state(false);
  let fixLaunched = $state(false);
  let ciFixStarting = $state(false);
  let ciFixLaunched = $state(false);
  let fixButtonState = $derived(
    getFixButtonState({
      refreshing,
      fixStarting,
      fixLaunched,
      sessionActive: sessionActiveForPlan,
      activeSessionId: activeSessionIdForPlan,
    })
  );
  let ciFixButtonState = $derived(
    getFixButtonState(
      {
        refreshing,
        fixStarting: ciFixStarting,
        fixLaunched: ciFixLaunched,
        sessionActive: ciFixSessionActiveForPlan,
        activeSessionId: ciFixActiveSessionIdForPlan,
      },
      'Fix CI'
    )
  );

  // Reset fixLaunched when session discovery catches up or plan changes
  $effect(() => {
    if (sessionActiveForPlan && fixLaunched) {
      fixLaunched = false;
    }
  });

  $effect(() => {
    if (ciFixSessionActiveForPlan && ciFixLaunched) {
      ciFixLaunched = false;
    }
  });

  // function getGraphitePrUrl(pr: { status: { owner: string; repo: string; pr_number: number } }) {
  //   return `https://app.graphite.com/github/pr/${pr.status.owner}/${pr.status.repo}/${pr.status.pr_number}`;
  // }

  // Reset launch state when navigating to a different plan
  $effect(() => {
    // Reading planUuid registers the dependency
    void planUuid;
    fixLaunched = false;
    fixStarting = false;
    ciFixLaunched = false;
    ciFixStarting = false;
    rebaseLaunched.clear();
  });

  // Timeout fallback: if no session appears within 30s, reset fixLaunched
  $effect(() => {
    if (!fixLaunched) return;
    const timer = setTimeout(() => {
      fixLaunched = false;
    }, 30_000);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!ciFixLaunched) return;
    const timer = setTimeout(() => {
      ciFixLaunched = false;
    }, 30_000);
    return () => clearTimeout(timer);
  });

  async function handleStartFix(option: ChatExecutorOption) {
    if (fixStarting || fixLaunched || sessionActiveForPlan) {
      return;
    }
    const requestPlanUuid = planUuid;
    fixStarting = true;
    refreshError = null;
    try {
      const result = await startFixThreads({
        planUuid: requestPlanUuid,
        executor: option.executor,
        model: option.model,
      });
      if (planUuid !== requestPlanUuid) return;
      const fixResultState = getFixStartResultState(result.status);
      fixLaunched = fixResultState.fixLaunched;
      refreshError = fixResultState.message;
      if (fixResultState.fixLaunched) {
        toast.success('Agent started');
      }
    } catch (err) {
      if (planUuid !== requestPlanUuid) return;
      refreshError = `Failed to start fix: ${err}`;
    } finally {
      if (planUuid === requestPlanUuid) {
        fixStarting = false;
      }
    }
  }

  async function handleStartCiFix() {
    if (ciFixStarting || ciFixLaunched || ciFixSessionActiveForPlan) {
      return;
    }
    const requestPlanUuid = planUuid;
    ciFixStarting = true;
    refreshError = null;
    try {
      const result = await startCiFix({ planUuid: requestPlanUuid });
      if (planUuid !== requestPlanUuid) return;
      const fixResultState = getFixStartResultState(result.status);
      ciFixLaunched = fixResultState.fixLaunched;
      refreshError = fixResultState.message;
      if (fixResultState.fixLaunched) {
        toast.success('CI fix agent started');
      }
    } catch (err) {
      if (planUuid !== requestPlanUuid) return;
      refreshError = `Failed to start CI fix: ${err}`;
    } finally {
      if (planUuid === requestPlanUuid) {
        ciFixStarting = false;
      }
    }
  }

  async function handleRefresh() {
    await runRefresh(refreshPrStatus);
  }

  async function handleFullRefresh() {
    await runRefresh(fullRefreshPrStatus);
  }

  async function runRefresh(refreshAction: typeof refreshPrStatus | typeof fullRefreshPrStatus) {
    refreshing = true;
    refreshError = null;
    try {
      const result = await refreshAction({ planUuid });
      if (result.error) {
        refreshError = result.error;
      }
    } catch (err) {
      refreshError = `Failed to refresh: ${err}`;
    } finally {
      refreshing = false;
    }
  }

  onMount(() => {
    return sessionManager.onEvent((eventName, event) => {
      if (eventName !== 'pr:updated') {
        return;
      }

      const allPrUrls = [...prData.prUrls, ...prData.prStatuses.map((pr) => pr.status.pr_url)];
      if (!hasRelevantPrUpdate(event, allPrUrls)) {
        return;
      }

      getPrStatus({ planUuid }).refresh();
    });
  });
</script>

<div>
  <div class="mb-2 flex items-center justify-between">
    <h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      Pull Requests
    </h3>
    <div class="flex items-center gap-1.5">
      {#if hasFailingOwnPr}
        {#if ciFixButtonState.activeSessionId}
          <ActiveSessionLink
            {projectId}
            connectionId={ciFixButtonState.activeSessionId}
            class="rounded px-2 py-0.5 text-xs text-red-700 hover:bg-red-50 hover:text-red-900 dark:text-red-400 dark:hover:bg-red-950/30 dark:hover:text-red-300"
          />
        {:else}
          <button
            onclick={handleStartCiFix}
            disabled={ciFixButtonState.disabled}
            class="rounded px-2 py-0.5 text-xs text-red-700 hover:bg-red-50 hover:text-red-900 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/30 dark:hover:text-red-300"
            aria-label="Fix failing CI checks"
          >
            {ciFixButtonState.label}
          </button>
        {/if}
      {/if}
      {#if hasUnresolvedThreads}
        {#if fixButtonState.activeSessionId}
          <ActiveSessionLink
            {projectId}
            connectionId={fixButtonState.activeSessionId}
            class="rounded px-2 py-0.5 text-xs text-amber-700 hover:bg-amber-50 hover:text-amber-900 dark:text-amber-400 dark:hover:bg-amber-950/30 dark:hover:text-amber-300"
          />
        {:else}
          <ExecutorChoiceDropdown
            label={fixButtonState.label}
            options={prFixExecutorOptions}
            disabled={fixButtonState.disabled}
            onselect={handleStartFix}
            buttonClass="rounded px-2 py-0.5 text-xs text-amber-700 hover:bg-amber-50 hover:text-amber-900 disabled:opacity-50 dark:text-amber-400 dark:hover:bg-amber-950/30 dark:hover:text-amber-300"
            ariaLabel="Fix all unresolved review threads"
          />
        {/if}
      {/if}
      {#if tokenConfigured}
        <button
          onclick={handleFullRefresh}
          disabled={refreshing}
          class="rounded px-2 py-0.5 text-[11px] text-muted-foreground/80 hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
          aria-label={refreshing
            ? 'Refreshing PR status from GitHub'
            : 'Fully refresh PR status from GitHub'}
        >
          Full Refresh
        </button>
      {/if}
      <button
        onclick={handleRefresh}
        disabled={refreshing}
        class="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
        aria-label={refreshing ? 'Refreshing PR status' : 'Refresh PR status'}
      >
        {refreshing ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
  </div>

  {#if refreshError}
    <p class="mb-2 text-xs text-amber-600 dark:text-amber-400">{refreshError}</p>
  {/if}

  <div class="space-y-4">
    {#if invalidPrUrls.length > 0}
      <div
        class="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
      >
        <div class="font-medium">Invalid pull request entries</div>
        <ul class="mt-1 space-y-1 text-xs">
          {#each invalidPrUrls as invalidUrl (invalidUrl)}
            <li class="break-all">{invalidUrl}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#each effectivePrs as pr (pr.status.pr_url)}
      {@const stackedOnPr = getStackedOnPullRequest(pr, effectivePrs)}
      <div class="rounded-md border border-gray-200 p-3 dark:border-gray-700">
        <!-- PR Header -->
        <div class="flex items-start gap-2">
          <a
            href="/projects/{projectId}/prs/{pr.status.pr_number}"
            class="min-w-0 flex-1 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            #{pr.status.pr_number}
            {#if pr.status.title}
              {pr.status.title}
            {/if}
          </a>
          <button
            onclick={() => handleStartAutoreview(pr.status)}
            disabled={autoreviewStarting.has(pr.status.pr_url) ||
              sessionManager.hasActiveSessionForPr(pr.status.pr_url).active}
            class="shrink-0 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800"
            aria-label="Run autoreview for PR #{pr.status.pr_number}"
            title="Review this PR branch against its base"
          >
            {autoreviewStarting.has(pr.status.pr_url) ? 'Starting...' : 'Autoreview'}
          </button>
          <a
            href={getExternalPrUrl(pr)}
            target="_blank"
            rel="noopener noreferrer"
            class="shrink-0 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
            aria-label="View PR #{pr.status.pr_number} in Linear Review"
          >
            View in Linear Review
          </a>
          <a
            href={pr.status.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            class="shrink-0 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
            aria-label="View PR #{pr.status.pr_number} in GitHub"
          >
            View in GitHub
          </a>
          <!-- <a
            href={getGraphitePrUrl(pr)}
            target="_blank"
            rel="noopener noreferrer"
            class="shrink-0 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
            title="View in Graphite"
            aria-label="View PR #{pr.status.pr_number} in Graphite"
          >
            View in Graphite
          </a> -->
        </div>

        {#if effectivePrs.length > 1 && pr.status.head_branch}
          <div class="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <span>Branch:</span>
            <CopyButton
              text={pr.status.head_branch}
              mode="text"
              label={pr.status.head_branch}
              className="rounded px-1 font-mono text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
              title="Copy branch name"
              ariaLabel="Copy branch name"
              onCopied={() => toast.success('Branch name copied')}
            />
          </div>
        {/if}

        {#if stackedOnPr}
          <div class="mt-1 text-xs text-muted-foreground">
            Stacked on
            <a
              href="/projects/{projectId}/prs/{stackedOnPr.status.pr_number}"
              class="text-blue-600 hover:underline dark:text-blue-400"
            >
              #{stackedOnPr.status.pr_number}
              {stackedOnPr.status.title ?? 'Untitled'}
            </a>
          </div>
        {/if}

        <!-- Badges -->
        <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span
            class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {stateBadgeColor(
              pr.status.state,
              pr.status.draft
            )}"
          >
            {stateLabel(pr.status.state, pr.status.draft)}
          </span>
          {#if pr.status.state === 'open' && pr.status.merge_queue_enqueued_at}
            <PrMergeQueueBadge enqueuedAt={pr.status.merge_queue_enqueued_at} />
          {/if}
          <span
            class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {checksBadgeColor(
              pr.status.check_rollup_state
            )}"
          >
            {checksLabel(pr.status.check_rollup_state)}
          </span>
          {#if getEffectiveReviewDecision(pr)}
            <span
              class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {reviewDecisionBadgeColor(
                getEffectiveReviewDecision(pr)
              )}"
            >
              {reviewDecisionLabel(getEffectiveReviewDecision(pr))}
            </span>
          {/if}
          {#if pr.status.mergeable === 'CONFLICTING'}
            <span
              class="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-300"
            >
              Conflicts
            </span>
          {/if}
        </div>

        <!-- Actions -->
        {#if pr.status.state === 'open'}
          {@const ownPr = isOwnPr(pr.status)}
          {@const showFixConflicts = isPrRebaseEligible(pr)}
          {@const timReviewLabelPresent = hasTimReviewLabel(pr)}
          {#if tokenConfigured || showFixConflicts}
            <div class="mt-1.5 flex flex-wrap items-center gap-1">
              {#if showFixConflicts}
                {@const rebaseActiveSessionId = getRebaseActiveSessionId(pr.status)}
                {#if rebaseActiveSessionId !== null}
                  <ActiveSessionLink
                    {projectId}
                    connectionId={rebaseActiveSessionId}
                    class="rounded px-2 py-0.5 text-xs text-red-700 hover:bg-red-50 hover:text-red-900 dark:text-red-400 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                  />
                {:else}
                  <button
                    onclick={() => handleStartRebase(pr.status)}
                    disabled={refreshing ||
                      rebaseStarting.has(pr.status.pr_url) ||
                      rebaseLaunched.has(pr.status.pr_url)}
                    class="rounded px-2 py-0.5 text-xs text-red-700 hover:bg-red-50 hover:text-red-900 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                    aria-label="Fix merge conflicts for PR #{pr.status.pr_number}"
                    title="Start a session that rebases this PR onto its base branch and resolves the conflicts"
                  >
                    {rebaseStarting.has(pr.status.pr_url)
                      ? 'Starting...'
                      : rebaseLaunched.has(pr.status.pr_url)
                        ? 'Starting session...'
                        : 'Fix Conflicts'}
                  </button>
                {/if}
              {/if}
              {#if tokenConfigured && ownPr}
                <button
                  onclick={() => handleToggleDraftStatus(pr.status)}
                  disabled={draftUpdating.has(pr.status.pr_url)}
                  class="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800"
                  aria-label="{pr.status.draft
                    ? 'Mark ready for review'
                    : 'Convert to draft'} PR #{pr.status.pr_number}"
                >
                  {draftUpdating.has(pr.status.pr_url)
                    ? 'Updating...'
                    : pr.status.draft
                      ? 'Mark ready for review'
                      : 'Convert to draft'}
                </button>
              {/if}
              {#if tokenConfigured}
                <button
                  onclick={() => handleRequestTimReview(pr.status)}
                  disabled={timReviewRequesting.has(pr.status.pr_url) || timReviewLabelPresent}
                  class="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800"
                  aria-label="Request tim review for PR #{pr.status.pr_number}"
                  title={timReviewLabelPresent
                    ? `The ${REVIEW_LABEL_NAME} label is on this PR. tim removes it after it posts the review.`
                    : `Add the ${REVIEW_LABEL_NAME} label to request an automatic tim review`}
                >
                  {timReviewRequesting.has(pr.status.pr_url)
                    ? 'Requesting...'
                    : timReviewLabelPresent
                      ? 'tim review requested'
                      : 'Request tim review'}
                </button>
              {/if}
            </div>
          {/if}
        {/if}

        <!-- Labels -->
        {#if pr.labels.length > 0}
          <div class="mt-1.5 flex flex-wrap gap-1">
            {#each pr.labels as label (label.name)}
              <span
                class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                style={labelStyle(label.color)}
              >
                {label.name}
              </span>
            {/each}
          </div>
        {/if}

        <!-- Diff stats -->
        {#if pr.status.additions != null && pr.status.deletions != null && pr.status.changed_files != null}
          <div class="mt-1.5 text-xs text-muted-foreground">
            {pr.status.changed_files} file{pr.status.changed_files === 1 ? '' : 's'} changed,
            <span class="text-green-600 dark:text-green-400">+{pr.status.additions}</span>
            /
            <span class="text-red-600 dark:text-red-400">-{pr.status.deletions}</span>
          </div>
        {/if}

        {#if latestReviewGuidesByPrUrl[pr.status.pr_url]}
          <div class="mt-1.5 text-xs text-muted-foreground">
            <a
              href="/projects/{projectId}/prs/{pr.status
                .pr_number}/reviews/{latestReviewGuidesByPrUrl[pr.status.pr_url].id}"
              class="text-blue-600 hover:underline dark:text-blue-400"
            >
              Latest review guide
            </a>
          </div>
        {/if}

        <!-- Expandable Check Runs -->
        {#if pr.checks.length > 0}
          <details class="mt-2">
            <summary
              class="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {pr.checks.length} check{pr.checks.length === 1 ? '' : 's'}
            </summary>
            <div class="mt-1.5 pl-2">
              <PrCheckRunList checks={pr.checks} requiredCheckNames={pr.requiredCheckNames ?? []} />
            </div>
          </details>
        {/if}

        <!-- Expandable Reviews -->
        {#if pr.reviews.length > 0}
          <details class="mt-2">
            <summary
              class="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {pr.reviews.length} review{pr.reviews.length === 1 ? '' : 's'}
            </summary>
            <div class="mt-1.5 pl-2">
              <PrReviewList reviews={pr.reviews} />
            </div>
          </details>
        {/if}

        <!-- Expandable Review Threads -->
        {#if pr.reviewThreads?.length}
          {@const unresolvedCount = pr.reviewThreads.filter((t) => !t.thread.is_resolved).length}
          <details class="mt-2">
            <summary
              class="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {pr.reviewThreads.length} review thread{pr.reviewThreads.length === 1 ? '' : 's'}
              {#if unresolvedCount > 0}
                <span class="text-amber-600 dark:text-amber-400">
                  ({unresolvedCount} unresolved)
                </span>
              {/if}
            </summary>
            <div class="mt-1.5 pl-2">
              <PrReviewThreadList threads={pr.reviewThreads} prUrl={pr.status.pr_url} {planUuid} />
            </div>
          </details>
        {/if}
      </div>
    {/each}

    {#each uncachedUrls as url (url)}
      <div class="rounded-md border border-gray-200 p-3 dark:border-gray-700">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          class="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          {url}
        </a>
      </div>
    {/each}
  </div>
</div>
