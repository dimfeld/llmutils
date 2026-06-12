<script lang="ts">
  import AppWindow from '@lucide/svelte/icons/app-window';
  import Download from '@lucide/svelte/icons/download';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Upload from '@lucide/svelte/icons/upload';
  import { toast } from 'svelte-sonner';

  import type { PlanDetail } from '$lib/server/db_queries.js';
  import type { ReviewWithIssueCounts } from '$tim/db/review.js';
  import type { PrStatusRow } from '$tim/db/pr_status.js';
  import { renderMarkdown } from '$lib/utils/markdown_parser.js';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import { onDestroy, untrack } from 'svelte';
  import { afterNavigate, invalidateAll } from '$app/navigation';
  import { updatePlanMetadata } from '$lib/remote/plan_metadata.remote.js';
  import { extractPlanMetadataErrorMessage } from './plan_metadata_form_utils.js';
  import {
    startGenerate,
    startAgent,
    startChat,
    startRebase,
    startReview,
    startReviewIssuesFix,
    startAutoreview,
    startShell,
    startUpdateDocs,
    startCreatePr,
    startPlanReviewGuide,
    startProof,
    startUploadArtifacts,
    finishPlanQuick,
    openInEditor,
  } from '$lib/remote/plan_actions.remote.js';
  import { isPlanEligibleForProofWithConfigured } from '$lib/utils/proof_eligibility.js';
  import { hasUploadableArtifacts } from '$lib/utils/artifact_upload_eligibility.js';
  import {
    removeReviewIssue,
    convertReviewIssueToTask,
    clearReviewIssues,
  } from '$lib/remote/review_issue_actions.remote.js';
  import { getPlanSyncStatus } from '$lib/remote/sync_status.remote.js';
  import { getEntityBadgeState } from './sync_indicator_state.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import StatusBadge from './StatusBadge.svelte';
  import PriorityBadge from './PriorityBadge.svelte';
  import RunChildrenPanel from './RunChildrenPanel.svelte';
  import { isAgentEligibleChild } from './run_children_panel/eligibility.js';
  import PrStatusSection from './PrStatusSection.svelte';
  import CopyButton from './CopyButton.svelte';
  import PlanArtifactsList from './PlanArtifactsList.svelte';
  import PlanArtifactUploader from './PlanArtifactUploader.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Collapsible from '$lib/components/ui/collapsible/index.js';
  import ActionButtonWithDropdown, { type ActionItem } from './ActionButtonWithDropdown.svelte';

  let {
    plan,
    reviews = [],
    projectId,
    projectName,
    tab = 'plans',
    openInEditorEnabled = false,
    proofConfigured = false,
    mediaHostConfigured = false,
  }: {
    plan: PlanDetail;
    reviews?: ReviewWithIssueCounts[];
    projectId: string;
    projectName?: string;
    tab?: string;
    openInEditorEnabled?: boolean;
    proofConfigured?: boolean;
    mediaHostConfigured?: boolean;
  } = $props();

  const sessionManager = useSessionManager();

  let planSyncQuery = $derived(plan.uuid ? getPlanSyncStatus({ planUuid: plan.uuid }) : null);
  let planSyncStatus = $derived(planSyncQuery?.current ?? null);
  let planSyncBadge = $derived(getEntityBadgeState(planSyncStatus));

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
    'reviewed',
    'cancelled',
    'deferred',
    'recently_done',
  ]);

  let isIneligible = $derived(INELIGIBLE_STATUSES.has(plan.displayStatus));
  let hasTasks = $derived(plan.tasks.length > 0);
  let isTasklessEpic = $derived(plan.epic && !hasTasks);
  let hasIncompleteTasks = $derived(plan.taskCounts.done < plan.taskCounts.total);
  let tasksOpen = $derived(plan.taskCounts.done < plan.taskCounts.total);
  let isBlocked = $derived(plan.displayStatus === 'blocked');
  let isSimplePlan = $derived(plan.simple === true);
  let isPending = $derived(plan.displayStatus === 'pending');

  function isVisiblePrStatus(status: PrStatusRow): boolean {
    return status.state !== 'closed' || status.merged_at !== null;
  }

  let visiblePrStatuses = $derived(plan.prStatuses.filter((pr) => isVisiblePrStatus(pr.status)));
  let hiddenPrStatusUrls = $derived(
    new Set(
      plan.prStatuses.filter((pr) => !isVisiblePrStatus(pr.status)).map((pr) => pr.status.pr_url)
    )
  );
  let visiblePullRequests = $derived(
    plan.pullRequests.filter((prUrl) => !hiddenPrStatusUrls.has(prUrl))
  );

  let canRenderRunChildren = $derived(
    plan.epic === true &&
      (plan.children?.length ?? 0) > 0 &&
      (plan.children ?? []).some(isAgentEligibleChild)
  );

  let actionConfig = $derived.by(() => {
    // needs_review plans and taskless epics: show "Finish" as primary button
    // If finish executor work is needed (docs or lessons not yet applied), show "Update Docs" instead
    let showFinish = plan.displayStatus === 'needs_review' || isTasklessEpic;
    let showUpdateDocs =
      plan.displayStatus === 'needs_review' && plan.canUpdateDocs && !isTasklessEpic;

    // Plans with incomplete tasks: show single "Run Agent" button
    let showAgentOnly = hasTasks && hasIncompleteTasks && !isIneligible && !showFinish;
    // Plans without tasks: show "Run Agent" as primary + "Generate" as a separate action button
    let showGenerateWithAgent = !hasTasks && !isIneligible && !showFinish;

    // done plans with pending doc updates: show "Update Docs" in dropdown
    // Use raw status (not displayStatus) since recently-done plans render as 'recently_done'
    let showUpdateDocsInDropdown = !isTasklessEpic && plan.status === 'done' && plan.canUpdateDocs;

    const chatItem: ActionItem = {
      label: 'Chat',
      startingLabel: 'Starting…',
      onclick: () => (chatDialogOpen = true),
      colorClass:
        'bg-slate-200 text-slate-800 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600',
      starting: !!startingChat,
    };
    const agentItem: ActionItem = {
      label: 'Run Agent',
      startingLabel: 'Starting…',
      onclick: handleRunAgent,
      colorClass: '',
      starting: startingAgent,
    };
    const generateItem: ActionItem = {
      label: 'Generate',
      startingLabel: 'Starting…',
      onclick: handleGenerate,
      colorClass:
        'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600',
      starting: startingGenerate,
    };
    const finishItem: ActionItem = {
      label: 'Finish',
      startingLabel: 'Starting…',
      onclick: handleFinish,
      colorClass:
        'bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600',
      starting: startingFinish,
    };
    const rebaseItem: ActionItem = {
      label: 'Rebase',
      startingLabel: 'Starting Rebase…',
      onclick: handleRebase,
      colorClass: '',
      starting: startingRebase,
    };
    const reviewItem: ActionItem = {
      label: 'Review',
      startingLabel: 'Starting Review…',
      onclick: handleReview,
      colorClass: '',
      starting: startingReview,
    };
    const autoreviewItem: ActionItem = {
      label: 'Autoreview',
      startingLabel: 'Starting Autoreview…',
      onclick: handleAutoreview,
      colorClass: '',
      starting: startingAutoreview,
    };
    const shellItem: ActionItem = {
      label: 'Shell',
      startingLabel: 'Starting Shell…',
      onclick: handleShell,
      colorClass: '',
      starting: startingShell,
    };
    const createPrItem: ActionItem = {
      label: 'Create PR',
      startingLabel: 'Starting PR Creation…',
      onclick: handleCreatePr,
      colorClass: '',
      starting: startingCreatePr,
    };
    const finishNoMarkDoneItem: ActionItem = {
      label: 'Update Docs',
      startingLabel: 'Starting Updating Docs…',
      onclick: handleUpdateDocs,
      colorClass: '',
      starting: startingFinish,
    };
    const proofItem: ActionItem = {
      label: 'Generate Proof',
      startingLabel: 'Starting Proof…',
      onclick: handleProof,
      colorClass: '',
      starting: startingProof,
    };
    const uploadArtifactsItem: ActionItem = {
      label: 'Upload artifacts to PR',
      startingLabel: 'Starting upload…',
      onclick: handleUploadArtifacts,
      colorClass: '',
      starting: startingUploadArtifacts,
    };

    let primary: ActionItem;
    let menuItems: ActionItem[] = [];
    let fixedActions: ActionItem[] = [autoreviewItem, shellItem];

    if (showUpdateDocs) {
      // Show "Update Docs" as primary, with "Finish" in dropdown
      primary = finishNoMarkDoneItem;
      if (isEligibleForRebase) menuItems.push(rebaseItem);
      if (isEligibleForCreatePr) menuItems.push(createPrItem);
      if (isEligibleForReview) menuItems.push(reviewItem);
      menuItems.push(chatItem);
      menuItems.push(finishItem);
      if (isEligibleForProof) menuItems.push(proofItem);
      if (isEligibleForUploadArtifacts) menuItems.push(uploadArtifactsItem);
    } else if (showFinish) {
      // Show "Finish" as primary (marks plan as done)
      primary = finishItem;
      if (isEligibleForRebase) menuItems.push(rebaseItem);
      if (isEligibleForCreatePr) menuItems.push(createPrItem);
      if (isEligibleForReview) menuItems.push(reviewItem);
      menuItems.push(chatItem);
      if (isEligibleForProof) menuItems.push(proofItem);
      if (isEligibleForUploadArtifacts) menuItems.push(uploadArtifactsItem);
    } else if (showAgentOnly) {
      // Surface "Run Agent" as its own standalone button (not buried in the dropdown).
      fixedActions = [agentItem, autoreviewItem, shellItem];
      if (isEligibleForRebase) menuItems.push(rebaseItem);
      if (isEligibleForCreatePr) menuItems.push(createPrItem);
      menuItems.push(chatItem);
      if (isEligibleForProof) menuItems.push(proofItem);
      if (isEligibleForUploadArtifacts) menuItems.push(uploadArtifactsItem);
      primary = menuItems.shift()!;
    } else if (showGenerateWithAgent) {
      if (isSimplePlan) {
        // Surface "Run Agent" as its own standalone button (not buried in the dropdown).
        fixedActions = [agentItem, autoreviewItem, shellItem];
        if (isEligibleForRebase) menuItems.push(rebaseItem);
        if (isEligibleForCreatePr) menuItems.push(createPrItem);
        menuItems.push(chatItem);
        if (isEligibleForProof) menuItems.push(proofItem);
        if (isEligibleForUploadArtifacts) menuItems.push(uploadArtifactsItem);
        primary = menuItems.shift()!;
      } else {
        // Eligible for Generate: surface both "Run Agent" and "Generate" as their
        // own standalone buttons (not buried in the dropdown).
        fixedActions = [agentItem, generateItem, autoreviewItem, shellItem];
        if (isEligibleForRebase) menuItems.push(rebaseItem);
        if (isEligibleForCreatePr) menuItems.push(createPrItem);
        menuItems.push(chatItem);
        if (isEligibleForProof) menuItems.push(proofItem);
        if (isEligibleForUploadArtifacts) menuItems.push(uploadArtifactsItem);
        primary = menuItems.shift()!;
      }
    } else {
      primary = shellItem;
      fixedActions = [autoreviewItem];
      if (isEligibleForRebase) menuItems.push(rebaseItem);
      if (isEligibleForCreatePr) menuItems.push(createPrItem);
      if (showUpdateDocsInDropdown) {
        menuItems.push(finishNoMarkDoneItem);
      }
      menuItems.push(chatItem);
      if (isEligibleForProof) menuItems.push(proofItem);
      if (isEligibleForUploadArtifacts) menuItems.push(uploadArtifactsItem);
    }

    // Pending plans haven't produced work to review yet, so hide Autoreview.
    if (isPending) {
      fixedActions = fixedActions.filter((action) => action !== autoreviewItem);
    }

    return { primary, menuItems, fixedActions };
  });

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

  const REBASE_ELIGIBLE_STATUSES = new Set(['in_progress', 'needs_review', 'reviewed', 'done']);
  let isEligibleForRebase = $derived(REBASE_ELIGIBLE_STATUSES.has(plan.status));

  let isEligibleForReview = $derived(plan.status === 'needs_review');

  const CREATE_PR_ELIGIBLE_STATUSES = new Set(['in_progress', 'needs_review', 'reviewed', 'done']);
  let isEligibleForCreatePr = $derived(
    CREATE_PR_ELIGIBLE_STATUSES.has(plan.status) &&
      !plan.epic &&
      visiblePrStatuses.length === 0 &&
      visiblePullRequests.length === 0
  );

  let startingGenerate = $state(false);
  let startingAgent = $state(false);
  let startingRebase = $state(false);
  let startingReview = $state(false);
  let startingAutoreview = $state(false);
  let startingShell = $state(false);
  let startingChat: 'claude' | 'codex' | false = $state(false);
  let startingFinish = $state(false);
  let startingCreatePr = $state(false);
  let reviewGuideRunning: 'full' | 'guide-only' | false = $state(false);
  let startingReviewIssuesFix = $state(false);
  let artifactDialogOpen = $state(false);
  let startingProof = $state(false);
  let startingUploadArtifacts = $state(false);
  let activeArtifactCount = $derived(
    (plan.artifacts ?? []).filter((a) => a.deletedAt === null).length
  );
  let hasLinkedPr = $derived((plan.pullRequests ?? []).length > 0);
  let isEligibleForUploadArtifacts = $derived(
    mediaHostConfigured && hasUploadableArtifacts(plan) && hasLinkedPr
  );

  let hasInProgressReview = $derived(
    reviews.some((r) => r.status === 'pending' || r.status === 'in_progress')
  );

  const REVIEW_GUIDE_LAUNCH_TIMEOUT_MS = 30_000;
  let reviewGuideResetTimeout: ReturnType<typeof setTimeout> | null = null;

  function clearReviewGuideResetTimeout() {
    if (reviewGuideResetTimeout) {
      clearTimeout(reviewGuideResetTimeout);
      reviewGuideResetTimeout = null;
    }
  }

  async function handleStartReviewGuide(guideOnly: boolean = false) {
    if (reviewGuideRunning || hasInProgressReview) return;
    reviewGuideRunning = guideOnly ? 'guide-only' : 'full';
    errorMessage = null;
    successMessage = null;
    try {
      await startPlanReviewGuide({ projectId: plan.projectId, planId: plan.planId, guideOnly });
      successMessage = { text: 'Review guide started' };
      setStartedSuccessfully();
      await invalidateAll();
      // After the loader refreshes, hasInProgressReview drives the disabled
      // state. If the new review row materialized, clear the optimistic flag
      // immediately so subsequent transitions (in_progress -> complete) re-enable
      // the button without waiting on the safety net.
      if (hasInProgressReview) {
        reviewGuideRunning = false;
      } else {
        // Safety net: if the spawned process fails before inserting an
        // in-progress review row, hasInProgressReview will never become true.
        // Always reset the flag after a short delay; hasInProgressReview
        // provides the ongoing disabled state when the row does exist.
        clearReviewGuideResetTimeout();
        reviewGuideResetTimeout = setTimeout(() => {
          reviewGuideRunning = false;
          reviewGuideResetTimeout = null;
        }, REVIEW_GUIDE_LAUNCH_TIMEOUT_MS);
      }
    } catch (err) {
      errorMessage = `${err as Error}`;
      reviewGuideRunning = false;
    }
  }

  function reviewGuideStatusLabel(status: string): string {
    return status === 'complete'
      ? 'Complete'
      : status === 'error'
        ? 'Error'
        : status === 'in_progress'
          ? 'Running'
          : 'Pending';
  }

  function prNumberFromUrl(prUrl: string): number | null {
    try {
      const url = new URL(prUrl);
      const segments = url.pathname.split('/').filter(Boolean);
      const prNumber =
        segments[2] === 'pull' || segments[2] === 'pulls' ? Number(segments[3]) : NaN;
      return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null;
    } catch {
      return null;
    }
  }

  function reviewGuideHref(review: {
    id: number;
    pr_url: string | null;
    plan_uuid: string | null;
  }): string {
    if (review.pr_url) {
      const prNumber = prNumberFromUrl(review.pr_url);
      if (prNumber != null) {
        return `/projects/${projectId}/prs/${prNumber}/reviews/${review.id}`;
      }
    }

    return `/projects/${projectId}/plans/${review.plan_uuid ?? plan.uuid}/reviews/${review.id}`;
  }

  let chatDialogOpen = $state(false);
  let startedSuccessfully = $state(false);
  let errorMessage: string | null = $state(null);
  let successMessage: { text: string; connectionId?: string } | null = $state(null);
  let reviewIssueSubmitting: number | 'clear' | null = $state(null);
  let editingNote = $state(false);
  let noteDraft = $state(untrack(() => plan.note ?? ''));
  let savingNote = $state(false);
  let noteErrorMessage: string | null = $state(null);
  let noteDirty = $derived(noteDraft.trim() !== (plan.note ?? '').trim());
  let canSaveNote = $derived(editingNote && noteDirty && !savingNote);

  function startNoteEdit() {
    noteDraft = plan.note ?? '';
    noteErrorMessage = null;
    editingNote = true;
  }

  function cancelNoteEdit() {
    noteDraft = plan.note ?? '';
    noteErrorMessage = null;
    editingNote = false;
  }

  async function handleSaveNote() {
    if (!canSaveNote) return;
    savingNote = true;
    noteErrorMessage = null;
    try {
      await updatePlanMetadata({
        projectId: plan.projectId,
        planUuid: plan.uuid,
        note: noteDraft || null,
      });
      await invalidateAll();
      editingNote = false;
      toast.success('Note saved');
    } catch (err) {
      noteErrorMessage = extractPlanMetadataErrorMessage(err);
    } finally {
      savingNote = false;
    }
  }

  function handleNoteKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleSaveNote();
    }
  }

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

  async function handleStartReviewIssuesFix() {
    if (startingReviewIssuesFix || activeSession) return;
    startingReviewIssuesFix = true;
    errorMessage = null;
    successMessage = null;
    try {
      const result = await startReviewIssuesFix({ planUuid: plan.uuid });
      if (result.status === 'already_running') {
        successMessage = {
          text: 'A session is already running for this plan',
          connectionId: result.connectionId,
        };
      } else {
        successMessage = { text: 'Review issue fixer started' };
      }
      setStartedSuccessfully();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingReviewIssuesFix = false;
    }
  }

  onDestroy(() => {
    clearReviewGuideResetTimeout();
  });

  afterNavigate(({ from, to }) => {
    if (from && to && from.url.pathname !== to.url.pathname) {
      startingGenerate = false;
      startingAgent = false;
      startingRebase = false;
      startingReview = false;
      startingAutoreview = false;
      startingShell = false;
      startingChat = false;
      startingFinish = false;
      startingCreatePr = false;
      reviewGuideRunning = false;
      startingReviewIssuesFix = false;
      clearReviewGuideResetTimeout();
      startingProof = false;
      chatDialogOpen = false;
      startedSuccessfully = false;
      reviewIssueSubmitting = null;
      editingNote = false;
      noteDraft = plan.note ?? '';
      savingNote = false;
      noteErrorMessage = null;
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
    startingGenerate ||
      startingAgent ||
      startingRebase ||
      startingReview ||
      startingAutoreview ||
      startingShell ||
      startingChat ||
      startingFinish ||
      startingCreatePr ||
      startingReviewIssuesFix ||
      startingProof
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

  async function handleReview() {
    startingReview = true;
    errorMessage = null;
    successMessage = null;
    try {
      const result = await startReview({ planUuid: plan.uuid });
      if (result.status === 'already_running') {
        successMessage = {
          text: 'A session is already running for this plan',
          connectionId: result.connectionId,
        };
      } else {
        successMessage = { text: 'Review started' };
      }
      setStartedSuccessfully();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingReview = false;
    }
  }

  async function handleAutoreview() {
    startingAutoreview = true;
    errorMessage = null;
    successMessage = null;
    try {
      const result = await startAutoreview({ planUuid: plan.uuid });
      if (result.status === 'already_running') {
        successMessage = {
          text: 'A session is already running for this plan',
          connectionId: result.connectionId,
        };
      } else {
        successMessage = { text: 'Autoreview started' };
      }
      setStartedSuccessfully();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingAutoreview = false;
    }
  }

  async function handleShell() {
    startingShell = true;
    errorMessage = null;
    successMessage = null;
    try {
      const result = await startShell({ planUuid: plan.uuid });
      if (result.status === 'already_running') {
        successMessage = {
          text: 'A session is already running for this plan',
          connectionId: result.connectionId,
        };
      } else {
        successMessage = { text: 'Shell started' };
      }
      setStartedSuccessfully();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingShell = false;
    }
  }

  async function handleCreatePr() {
    startingCreatePr = true;
    errorMessage = null;
    successMessage = null;
    try {
      const result = await startCreatePr({ planUuid: plan.uuid });
      if (result.status === 'already_running') {
        successMessage = {
          text: 'A session is already running for this plan',
          connectionId: result.connectionId,
        };
      } else {
        successMessage = { text: 'PR creation started' };
      }
      setStartedSuccessfully();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingCreatePr = false;
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

  const SEVERITY_ORDER: Record<string, number> = { critical: 0, major: 1, minor: 2, info: 3 };

  function parseLineStart(line: number | string | undefined): number {
    if (line === undefined) return Infinity;
    if (typeof line === 'number') return line;
    return parseInt(line, 10) || Infinity;
  }

  let sortedReviewIssues = $derived(
    plan.reviewIssues
      ? plan.reviewIssues
          .map((issue, originalIndex) => ({ issue, originalIndex }))
          .sort((a, b) => {
            const sevDiff =
              (SEVERITY_ORDER[a.issue.severity] ?? 99) - (SEVERITY_ORDER[b.issue.severity] ?? 99);
            if (sevDiff !== 0) return sevDiff;
            const fileA = a.issue.file ?? '';
            const fileB = b.issue.file ?? '';
            if (fileA !== fileB) return fileA.localeCompare(fileB);
            return parseLineStart(a.issue.line) - parseLineStart(b.issue.line);
          })
      : []
  );

  let isEligibleForProof = $derived(
    isPlanEligibleForProofWithConfigured(
      { status: plan.status, taskCounts: plan.taskCounts, tasks: plan.tasks },
      proofConfigured
    )
  );

  async function handleProof() {
    startingProof = true;
    errorMessage = null;
    successMessage = null;
    try {
      const result = await startProof({ planUuid: plan.uuid });
      if (result.status === 'already_running') {
        successMessage = {
          text: 'A session is already running for this plan',
          connectionId: result.connectionId,
        };
      } else {
        successMessage = { text: 'Proof generation started' };
      }
      setStartedSuccessfully();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingProof = false;
    }
  }

  async function handleUploadArtifacts() {
    startingUploadArtifacts = true;
    errorMessage = null;
    successMessage = null;
    try {
      const result = await startUploadArtifacts({ planUuid: plan.uuid });
      if (result.status === 'already_running') {
        successMessage = {
          text: 'A session is already running for this plan',
          connectionId: result.connectionId,
        };
      } else {
        successMessage = { text: 'Artifact upload started' };
      }
      setStartedSuccessfully();
      await invalidateAll();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingUploadArtifacts = false;
    }
  }

  async function handleUpdateDocs() {
    startingFinish = true;
    errorMessage = null;
    successMessage = null;
    try {
      if (!(plan.status === 'needs_review' || plan.status === 'done') || isTasklessEpic) {
        throw new Error('Plan is not eligible for doc updates');
      }
      const result = await startUpdateDocs({ planUuid: plan.uuid });
      if (result.status === 'already_running') {
        successMessage = {
          text: 'A session is already running for this plan',
          connectionId: result.connectionId,
        };
      } else {
        successMessage = { text: 'Update Docs started' };
      }
      setStartedSuccessfully();
      await invalidateAll();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingFinish = false;
    }
  }

  async function handleFinish() {
    startingFinish = true;
    errorMessage = null;
    successMessage = null;
    try {
      await finishPlanQuick({ planUuid: plan.uuid });
      successMessage = { text: 'Plan marked as done' };
      await invalidateAll();
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      startingFinish = false;
    }
  }

  let dependencyEntries = $derived.by(() => {
    const childUuids = new Set(plan.children.map((c) => c.uuid));
    const basePlan = plan.effectiveBasePlan ?? plan.basePlan;
    const siblingUuids = new Set(plan.siblings.map((sibling) => sibling.uuid));
    const entries = plan.dependencies.map((dep) => ({
      dep,
      isBase: basePlan?.uuid === dep.uuid,
      isChild: childUuids.has(dep.uuid),
      isSibling: siblingUuids.has(dep.uuid),
    }));
    if (basePlan && !entries.some((entry) => entry.dep.uuid === basePlan.uuid)) {
      entries.push({
        dep: basePlan,
        isBase: true,
        isChild: childUuids.has(basePlan.uuid),
        isSibling: siblingUuids.has(basePlan.uuid),
      });
    }
    return entries.sort((a, b) => {
      const aPlanId = a.dep.planId ?? Number.POSITIVE_INFINITY;
      const bPlanId = b.dep.planId ?? Number.POSITIVE_INFINITY;
      if (aPlanId !== bPlanId) {
        return aPlanId - bPlanId;
      }
      return a.dep.title?.localeCompare(b.dep.title ?? '') ?? 0;
    });
  });

  let childDependencyEntries = $derived(dependencyEntries.filter((e) => e.isChild));
  let nonChildDependencyEntries = $derived(
    dependencyEntries.filter((e) => !e.isChild && !e.isSibling)
  );
  let nonParentDependents = $derived.by(() => {
    const siblingUuids = new Set(plan.siblings.map((sibling) => sibling.uuid));
    return plan.dependents.filter(
      (dependent) => dependent.uuid !== plan.parent?.uuid && !siblingUuids.has(dependent.uuid)
    );
  });
  let siblingEntries = $derived.by(() => {
    const basePlanUuid = (plan.effectiveBasePlan ?? plan.basePlan)?.uuid;
    const dependentUuids = new Set(plan.dependents.map((dependent) => dependent.uuid));
    return plan.siblings
      .map((sibling) => ({
        dep: sibling,
        isBase: sibling.uuid === basePlanUuid,
        dependsOnCurrent: dependentUuids.has(sibling.uuid),
      }))
      .sort((a, b) => (a.dep.planId ?? 0) - (b.dep.planId ?? 0));
  });

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

<!-- Sticky plan number + title header -->
<div class="@container sticky top-0 z-10 border-b border-border bg-background px-4 py-3">
  <div class="flex flex-col gap-0.5 @md:flex-row @md:items-center @md:gap-2">
    <div class="flex shrink-0 items-center gap-2">
      <span class="text-sm font-medium text-muted-foreground">#{plan.planId}</span>
      {#if plan.epic}
        <span
          class="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
        >
          Epic
        </span>
      {/if}
    </div>
    <h2 class="text-xl font-semibold text-foreground">{plan.title ?? 'Untitled'}</h2>
    {#if planSyncBadge}
      <span
        class={[
          'rounded-full px-2 py-0.5 text-xs font-medium',
          planSyncBadge.tone === 'error'
            ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
            : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
        ]}
        title={planSyncBadge.title}
      >
        {planSyncBadge.label}
      </span>
    {/if}
  </div>
  {#if projectName}
    <div class="mt-0.5 text-sm text-muted-foreground">{projectName}</div>
  {/if}
</div>

<div
  class="overflow-x-hidden overflow-y-auto px-4 py-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
  role="region"
  aria-label="Plan details"
  tabindex="0"
>
  <div class="space-y-6 pb-4">
    <!-- Status badges + actions -->
    <div>
      <div class="flex items-center gap-2">
        <StatusBadge status={plan.displayStatus} />
        <PriorityBadge priority={plan.priority} />

        <div class="ml-auto flex items-center gap-2">
          <Button
            href={`/projects/${projectId}/plans/${plan.uuid}/edit`}
            size="xs"
            variant="outline"
            aria-label="Edit plan metadata"
            title="Edit plan metadata"
          >
            <Pencil class="h-3 w-3" />
            Edit
          </Button>
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
          {#if activeSession}
            <a
              href="/projects/{projectId}/sessions/{activeSession.connectionId}"
              class="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium transition-colors
              {activeSession.command === 'agent'
                ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:hover:bg-emerald-900/60'
                : activeSession.command === 'chat'
                  ? 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                  : activeSession.command === 'agent-multi'
                    ? 'bg-cyan-100 text-cyan-700 hover:bg-cyan-200 dark:bg-cyan-900/40 dark:text-cyan-300 dark:hover:bg-cyan-900/60'
                    : activeSession.command === 'update-docs'
                      ? 'bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60'
                      : activeSession.command === 'review-issues'
                        ? 'bg-orange-100 text-orange-700 hover:bg-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:hover:bg-orange-900/60'
                        : 'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:hover:bg-blue-900/60'}"
            >
              <span
                class="inline-block h-2 w-2 animate-pulse rounded-full {activeSession.command ===
                'agent'
                  ? 'bg-emerald-500'
                  : activeSession.command === 'chat'
                    ? 'bg-slate-400'
                    : activeSession.command === 'agent-multi'
                      ? 'bg-cyan-500'
                      : activeSession.command === 'update-docs'
                        ? 'bg-amber-500'
                        : activeSession.command === 'review-issues'
                          ? 'bg-orange-500'
                          : 'bg-blue-500'}"
              ></span>
              {activeSession.command === 'agent'
                ? 'Agent Running...'
                : activeSession.command === 'generate'
                  ? 'Generating...'
                  : activeSession.command === 'agent-multi'
                    ? 'Agent Multi Running...'
                    : activeSession.command === 'update-docs'
                      ? 'Updating Docs...'
                      : activeSession.command === 'review-issues'
                        ? 'Fixing Review Issues...'
                        : `${activeSession.command.charAt(0).toUpperCase() + activeSession.command.slice(1)} Running...`}
            </a>
          {:else}
            {@const { primary, menuItems, fixedActions } = actionConfig}
            <ActionButtonWithDropdown {primary} {menuItems} disabled={controlsDisabled} size="xs" />
            {#each fixedActions as action}
              <Button
                onclick={action.onclick}
                disabled={controlsDisabled}
                size="xs"
                class={action.colorClass}
              >
                {#if action.starting}
                  <span
                    class="inline-block h-2 w-2 animate-spin rounded-full border-2 border-white border-t-transparent"
                  ></span>
                  {action.startingLabel}
                {:else}
                  {action.label}
                {/if}
              </Button>
            {/each}
          {/if}
        </div>
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

    <!-- Run children (epic only) -->
    {#if canRenderRunChildren && activeSession?.command !== 'agent-multi'}
      <RunChildrenPanel
        epicPlanUuid={plan.uuid}
        {projectId}
        {tab}
        children={plan.children}
        externalPlanStatusByUuid={plan.childExternalDependencyStatuses ?? {}}
      />
    {/if}

    <!-- Goal -->
    {#if plan.goal}
      <div>
        <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Goal
        </h3>
        <p class="text-sm text-foreground">{plan.goal}</p>
      </div>
    {/if}

    <!-- Note -->
    <div>
      <div class="mb-1 flex items-center gap-2">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Note</h3>
        {#if !editingNote}
          <Button
            onclick={startNoteEdit}
            size="icon-xs"
            variant="ghost"
            aria-label={plan.note ? 'Edit note' : 'Add note'}
            title={plan.note ? 'Edit note' : 'Add note'}
          >
            <Pencil class="h-3 w-3" />
          </Button>
        {/if}
      </div>
      {#if editingNote}
        <div class="space-y-2">
          <Textarea
            id="plan-note-inline"
            placeholder="Internal note (Markdown supported)"
            bind:value={noteDraft}
            disabled={savingNote}
            aria-label="Plan note"
            onkeydown={handleNoteKeydown}
          />
          <div class="flex items-center gap-2">
            <Button onclick={handleSaveNote} disabled={!canSaveNote} size="xs">
              {savingNote ? 'Saving...' : 'Save'}
            </Button>
            <Button onclick={cancelNoteEdit} disabled={savingNote} size="xs" variant="outline">
              Cancel
            </Button>
            {#if noteErrorMessage}
              <p class="text-sm text-red-600 dark:text-red-400">{noteErrorMessage}</p>
            {/if}
          </div>
        </div>
      {:else if plan.note}
        <div class="plan-rendered-content text-sm text-foreground">
          {@html renderMarkdown(plan.note)}
        </div>
      {:else}
        <p class="text-sm text-muted-foreground">No note</p>
      {/if}
    </div>

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
                <CopyButton
                  text={taskCopyText}
                  mode="icon"
                  className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
                  idleClass="opacity-0 group-hover:opacity-100"
                  copiedClass="opacity-100"
                  iconClass="size-3"
                  title="Copy task"
                  ariaLabel="Copy task"
                />
              </li>
            {/each}
          </ul>
        </Collapsible.Content>
      </Collapsible.Root>
    {/if}

    <!-- Dependencies -->
    {#if nonChildDependencyEntries.length > 0}
      <div>
        <h3 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Depends On
        </h3>
        <ul class="space-y-1">
          {#each nonChildDependencyEntries as { dep, isBase } (dep.uuid)}
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
                {#if isBase}
                  <span
                    class="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                  >
                    Base Plan
                  </span>
                {/if}
                {#if dep.displayStatus}
                  <StatusBadge status={dep.displayStatus} />
                {/if}
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- Child dependencies -->
    {#if childDependencyEntries.length > 0}
      <div>
        <h3 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Children
        </h3>
        <ul class="space-y-1">
          {#each childDependencyEntries as { dep, isBase } (dep.uuid)}
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
                {#if isBase}
                  <span
                    class="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                  >
                    Base Plan
                  </span>
                {/if}
                {#if dep.displayStatus}
                  <StatusBadge status={dep.displayStatus} />
                {/if}
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- Dependents -->
    {#if nonParentDependents.length > 0}
      <div>
        <h3 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Depended on by
        </h3>
        <ul class="space-y-1">
          {#each nonParentDependents.sort((a, b) => (a.planId ?? 0) - (b.planId ?? 0)) as dep (dep.uuid)}
            <li class="text-sm">
              <a
                href={planUrl(dep.uuid, dep.projectId)}
                data-sveltekit-preload-data
                class="flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                {#if dep.planId}
                  <span class="text-xs font-medium text-muted-foreground">#{dep.planId}</span>
                {/if}
                <span class="text-foreground">{dep.title ?? 'Unknown plan'}</span>
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

    <!-- Siblings -->
    {#if siblingEntries.length > 0}
      <div>
        <h3 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Sibling Plans
        </h3>
        <ul class="space-y-1">
          {#each siblingEntries as { dep, isBase, dependsOnCurrent } (dep.uuid)}
            <li class="text-sm">
              <a
                href={planUrl(dep.uuid, dep.projectId)}
                data-sveltekit-preload-data
                class="flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                {#if dep.planId}
                  <span class="text-xs font-medium text-muted-foreground">#{dep.planId}</span>
                {/if}
                <span class="text-foreground">{dep.title ?? 'Unknown plan'}</span>
                {#if isBase}
                  <span
                    class="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                  >
                    Base Plan
                  </span>
                {/if}
                {#if dependsOnCurrent}
                  <span
                    class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                  >
                    Depends on this
                  </span>
                {/if}
                {#if dep.displayStatus}
                  <StatusBadge status={dep.displayStatus} />
                {/if}
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- Tags -->
    {#if plan.tags.length > 0}
      <div>
        <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Tags
        </h3>
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

    <!-- Branch -->
    {#if plan.branch || plan.effectiveBaseBranch || plan.basePlanResolutionWarning}
      <div>
        <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Branches
        </h3>
        <div class="space-y-1">
          {#if plan.branch}
            <div class="flex items-center gap-1">
              <span class="w-16 text-xs text-muted-foreground">Branch</span>
              <code class="text-xs">{plan.branch}</code>
              <CopyButton
                text={plan.branch}
                mode="icon"
                iconClass="size-3"
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
                title="Copy branch name"
                ariaLabel="Copy branch name"
                onCopied={() => toast.success('Branch name copied')}
              />
            </div>
          {/if}
          {#if plan.effectiveBaseBranch}
            <div class="flex items-center gap-1">
              <span class="w-16 text-xs text-muted-foreground">Base</span>
              <code class="text-xs">{plan.effectiveBaseBranch}</code>
              <CopyButton
                text={plan.effectiveBaseBranch}
                mode="icon"
                iconClass="size-3"
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
                title="Copy base branch name"
                ariaLabel="Copy base branch name"
                onCopied={() => toast.success('Base branch name copied')}
              />
            </div>
          {/if}
          {#if plan.basePlanResolutionWarning}
            <div
              class="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100"
            >
              <div class="font-medium">
                Base plan #{plan.basePlanResolutionWarning.epic.planId} is an unfinished epic.
              </div>
              {#if plan.basePlanResolutionWarning.kind === 'epic_base_terminal_child'}
                <div class="mt-1">
                  The effective base branch shown above comes from the epic, but the correct base is
                  likely the final child:
                  {#each plan.basePlanResolutionWarning.terminalChildren as child, index (child.uuid)}
                    {#if index > 0},
                    {/if}<a
                      class="font-medium underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-200"
                      href={planUrl(child.uuid, child.projectId)}
                      >#{child.planId} {child.title ?? 'Untitled'}</a
                    >
                  {/each}
                  {#if plan.basePlanResolutionWarning.recommendedBaseBranch}
                    (<code>{plan.basePlanResolutionWarning.recommendedBaseBranch}</code>)
                  {:else}
                    (no branch recorded yet)
                  {/if}.
                </div>
              {:else if plan.basePlanResolutionWarning.kind === 'epic_base_ambiguous'}
                <div class="mt-1">
                  The final child is ambiguous because multiple child plans have no later sibling
                  depending on them:
                  {#each plan.basePlanResolutionWarning.terminalChildren as child, index (child.uuid)}
                    {#if index > 0},
                    {/if}<a
                      class="font-medium underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-200"
                      href={planUrl(child.uuid, child.projectId)}
                      >#{child.planId} {child.title ?? 'Untitled'}</a
                    >
                  {/each}.
                </div>
              {:else}
                <div class="mt-1">
                  The epic has no child plan that can serve as the final base, so commands that need
                  a base branch may not be able to resolve one correctly.
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Pull Requests -->
    {#if visiblePullRequests.length > 0 || plan.invalidPrUrls.length > 0 || visiblePrStatuses.length > 0}
      <PrStatusSection planUuid={plan.uuid} {projectId} />
    {/if}

    <!-- Review Guides -->
    <div>
      <div class="mb-1.5 flex items-center justify-start gap-2">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Review Guides
        </h3>
        <div class="flex items-center gap-1">
          <button
            type="button"
            onclick={() => handleStartReviewGuide(false)}
            disabled={Boolean(reviewGuideRunning) || hasInProgressReview}
            class="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800"
            title="Generate a full review guide with issue extraction"
          >
            {reviewGuideRunning === 'full' ? 'Starting...' : 'Generate Full Guide'}
          </button>
          <button
            type="button"
            onclick={() => handleStartReviewGuide(true)}
            disabled={Boolean(reviewGuideRunning) || hasInProgressReview}
            class="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800"
            title="Generate only the review guide prompt output"
          >
            {reviewGuideRunning === 'guide-only' ? 'Starting...' : 'Generate Guide Only'}
          </button>
        </div>
      </div>

      {#if reviews.length > 0}
        <ul class="space-y-1">
          {#each reviews as review (review.id)}
            {@const statusColor =
              review.status === 'complete'
                ? 'text-green-600 dark:text-green-400'
                : review.status === 'error'
                  ? 'text-red-600 dark:text-red-400'
                  : review.status === 'in_progress'
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-muted-foreground'}
            <li
              class="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <a href={reviewGuideHref(review)} class="flex min-w-0 flex-1 items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-foreground tabular-nums">
                  #{review.id} - {formatRelativeTime(review.created_at)}
                </span>
                {#if review.status === 'complete'}
                  <span class="shrink-0 text-xs text-muted-foreground">
                    {review.unresolved_count}/{review.issue_count} open
                  </span>
                {/if}
                <span class="shrink-0 text-xs {statusColor}">
                  {reviewGuideStatusLabel(review.status)}
                </span>
              </a>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-xs text-muted-foreground">No review guides yet.</p>
      {/if}
    </div>

    <!-- Assignment -->
    {#if plan.assignment}
      <div>
        <h3 class="text-[11px] font-medium tracking-wide text-muted-foreground">
          Assigned Workspace
        </h3>
        <div class="mt-1 text-xs text-muted-foreground">
          {#each plan.assignment.workspacePaths as wsPath (wsPath)}
            <div class="mt-0.5 flex items-center gap-1">
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
            <div class="mt-0.5 text-[11px] text-muted-foreground">
              Users: {plan.assignment.users.join(', ')}
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Review Issues -->
    {#if plan.reviewIssues && plan.reviewIssues.length > 0}
      <div>
        <div class="mb-2 flex items-center justify-between">
          <h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Review Issues ({plan.reviewIssues.length})
          </h3>
          <div class="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onclick={handleStartReviewIssuesFix}
              disabled={reviewIssueSubmitting !== null ||
                startingReviewIssuesFix ||
                !!activeSession}
              aria-label="Fix saved review issues"
              title="Fix saved review issues"
            >
              <Pencil class="size-3" />
              {startingReviewIssuesFix ? 'Starting...' : 'Fix Issues'}
            </Button>
            <button
              type="button"
              onclick={handleClearReviewIssues}
              disabled={reviewIssueSubmitting !== null || startingReviewIssuesFix}
              class="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-red-100 hover:text-red-700 disabled:opacity-50 dark:hover:bg-red-950/50 dark:hover:text-red-400"
            >
              {reviewIssueSubmitting === 'clear' ? 'Clearing...' : 'Clear All'}
            </button>
          </div>
        </div>
        <ul class="space-y-2">
          {#each sortedReviewIssues as { issue, originalIndex } (originalIndex)}
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
            {@const issueCopyId = `issue-${originalIndex}`}
            {@const issueCopyText = [
              issue.file
                ? `${issue.file}${issue.line !== undefined ? `:${issue.line}` : ''}`
                : null,
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
                    onclick={() => handleConvertToTask(originalIndex)}
                    disabled={reviewIssueSubmitting !== null}
                    class="rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-blue-100 hover:text-blue-700 disabled:opacity-50 dark:hover:bg-blue-950/50 dark:hover:text-blue-400"
                    aria-label="Convert to task"
                    title="Convert to task"
                  >
                    {reviewIssueSubmitting === originalIndex ? '...' : '→ Task'}
                  </button>
                  <CopyButton
                    text={issueCopyText}
                    mode="icon"
                    className="rounded p-0.5 text-muted-foreground transition-opacity hover:bg-black/10 hover:text-foreground dark:hover:bg-white/10"
                    idleClass="opacity-0 group-hover:opacity-100"
                    copiedClass="opacity-100"
                    iconClass="size-3"
                    title="Copy issue"
                    ariaLabel="Copy issue"
                  />
                  <button
                    type="button"
                    onclick={() => handleRemoveReviewIssue(originalIndex)}
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
              <div class="plan-rendered-content mt-1 text-foreground">
                {@html renderMarkdown(issue.content)}
              </div>
              {#if issue.suggestion}
                <div class="mt-1 text-xs text-muted-foreground">
                  <span class="font-medium text-green-700 dark:text-green-400">Suggestion:</span>
                  <div class="plan-rendered-content mt-0.5 text-xs text-muted-foreground">
                    {@html renderMarkdown(issue.suggestion)}
                  </div>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- Artifacts -->
    <div class="space-y-2">
      <div class="flex justify-end gap-2">
        {#if activeArtifactCount > 0}
          <Button
            href={`/projects/${projectId}/plans/${plan.uuid}/artifacts`}
            variant="outline"
            size="xs"
            aria-label="View artifacts"
            title="View artifacts"
          >
            <AppWindow class="size-3" />
            View artifacts
          </Button>
          <Button
            href={`/api/plans/${plan.uuid}/artifacts/archive`}
            variant="outline"
            size="xs"
            aria-label="Download all artifacts"
            title="Download all artifacts"
          >
            <Download class="size-3" />
            Download ZIP
          </Button>
        {/if}
        <Button
          variant="outline"
          size="xs"
          onclick={() => (artifactDialogOpen = true)}
          aria-label="Add artifact"
        >
          <Upload class="size-3" />
          Add artifact
        </Button>
      </div>
      <PlanArtifactsList artifacts={plan.artifacts ?? []} />
    </div>

    <!-- Details -->
    {#if plan.details}
      <div>
        <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Details
        </h3>
        <div class="plan-rendered-content text-sm text-foreground">
          {@html renderMarkdown(plan.details ?? '')}
        </div>
      </div>
    {/if}

    <!-- Timestamps -->
    <div class="space-y-1 text-xs text-muted-foreground">
      <div>Created: {formatDate(plan.createdAt)}</div>
      <div>Updated: {formatDate(plan.updatedAt)}</div>
    </div>
  </div>
</div>

<Dialog.Root bind:open={artifactDialogOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Add Artifact</Dialog.Title>
      <Dialog.Description>Upload a file and include an optional message.</Dialog.Description>
    </Dialog.Header>
    <PlanArtifactUploader planUuid={plan.uuid} {projectId} />
  </Dialog.Content>
</Dialog.Root>

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
