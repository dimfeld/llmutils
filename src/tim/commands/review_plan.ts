import { getGitRoot, getMergeBase } from '../../common/git.js';
import { log, warn } from '../../logging.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import { getPlanByPlanId } from '../db/plan.js';
import { createReview } from '../db/review.js';
import { runWithHeadlessAdapterIfEnabled, updateHeadlessSessionInfo } from '../headless.js';
import { parsePlanIdFromCliArg, resolvePlanByNumericId } from '../plans.js';
import { resolveReviewExecutorSelection } from '../review_runner.js';
import { getSignalExitCode, isShuttingDown, setDeferSignalExit } from '../shutdown_state.js';
import { gatherPlanContext, type PlanContext } from '../utils/context_gathering.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import type { PlanReviewMetadata } from './review_pr_prompt.js';
import {
  buildReviewGuideDiffCatalog,
  loadCustomReviewInstructions,
  loadReviewGuideDiffCatalog,
  readCurrentHeadSha,
  resolveProjectContextForRepo,
  runReviewGuideWorkflow,
} from './review_workflow.js';

interface RootCommandLike {
  parent?: RootCommandLike | null;
  opts?: () => {
    config?: string;
  };
}

export interface PlanReviewGuideCommandOptions {
  executor?: string;
  autoWorkspace?: boolean;
  workspace?: string;
  model?: string;
  terminalInput?: boolean;
  nonInteractive?: boolean;
  verbose?: boolean;
}

function getRootOptions(command: RootCommandLike | undefined): { config?: string } {
  let current = command;
  while (current?.parent) {
    current = current.parent;
  }

  return current?.opts?.() ?? {};
}

export function buildPlanMetadata(
  planId: number,
  planUuid: string,
  context: PlanContext,
  headRef: string
): PlanReviewMetadata {
  const planData = context.planData;
  const mapRelatedPlans = (
    plans: PlanContext['parentChain'],
    label: string
  ): PlanReviewMetadata['parentChain'] => {
    return plans.flatMap((plan) => {
      const relatedPlanId = Number(plan.id);
      if (Number.isNaN(relatedPlanId)) {
        warn(
          `Warning: Skipping ${label} with non-numeric id "${String(plan.id)}" while building plan review metadata.`
        );
        return [];
      }

      return [
        {
          planId: relatedPlanId,
          title: plan.title ?? `(plan ${relatedPlanId})`,
        },
      ];
    });
  };

  return {
    kind: 'plan',
    planId,
    planUuid,
    title: planData.title ?? `(plan ${planId})`,
    goal: planData.goal ?? null,
    details: planData.details ?? null,
    tasks: planData.tasks.map((task) => ({
      title: task.title,
      status: task.done ? 'done' : 'pending',
    })),
    parentChain: mapRelatedPlans(context.parentChain, 'parent plan'),
    completedChildren: mapRelatedPlans(context.completedChildren, 'completed child plan'),
    baseBranch: context.diffResult.baseBranch,
    headRef,
  };
}

async function resolvePlanReviewBaseSha(
  context: PlanContext,
  baseDir: string
): Promise<string | null> {
  return (
    context.diffResult.mergeBaseCommit ??
    (await getMergeBase(baseDir, context.diffResult.baseBranch, 'HEAD', { useRemoteRef: false }))
  );
}

export async function handlePlanReviewGuideCommand(
  planArg: string | number,
  options: PlanReviewGuideCommandOptions,
  command: RootCommandLike
): Promise<void> {
  const planId = typeof planArg === 'number' ? planArg : parsePlanIdFromCliArg(planArg);
  const globalOpts = getRootOptions(command);
  const db = getDatabase();
  const initialRepoRoot = await getGitRoot(process.cwd());
  const config = await loadEffectiveConfig(globalOpts.config, { cwd: initialRepoRoot });
  const tunnelActive = isTunnelActive();
  const reviewInteractive = options.nonInteractive !== true;
  const effectiveTerminalInput =
    options.terminalInput !== false &&
    config.terminalInput !== false &&
    reviewInteractive &&
    process.stdin.isTTY;
  const reviewSelection = resolveReviewExecutorSelection(options.executor, config);

  let baseDir = initialRepoRoot;

  try {
    setDeferSignalExit(true);

    await runWithHeadlessAdapterIfEnabled({
      enabled: !tunnelActive,
      command: 'review-guide',
      interactive: reviewInteractive,
      callback: async () => {
        const { projectId, repoRoot } = await resolveProjectContextForRepo(db, baseDir);
        const planRow = getPlanByPlanId(db, projectId, planId);
        if (!planRow) {
          throw new Error(`Plan ${planId} was not found in the current project.`);
        }

        const resolvedPlan = await resolvePlanByNumericId(planId, repoRoot);
        updateHeadlessSessionInfo({
          linkedPlanId: planId,
          linkedPlanUuid: planRow.uuid,
          linkedPlanTitle: planRow.title ?? undefined,
        });

        const usesManagedWorkspace =
          options.autoWorkspace === true || options.workspace !== undefined;

        if (usesManagedWorkspace) {
          const workspaceResult = await setupWorkspace(
            {
              workspace: options.workspace,
              autoWorkspace: options.autoWorkspace,
              nonInteractive: options.nonInteractive,
              planId,
              planUuid: planRow.uuid,
              allowPrimaryWorkspaceWhenLocked: true,
            },
            baseDir,
            resolvedPlan.planPath ?? undefined,
            config,
            'tim review-guide'
          );
          baseDir = workspaceResult.baseDir;
          updateHeadlessSessionInfo({ workspacePath: baseDir });
        }

        const context = await gatherPlanContext(planId, { cwd: baseDir }, globalOpts);
        if (context.noChangesDetected) {
          log('No changes detected for plan review guide. Nothing to do.');
          return;
        }

        const customInstructions = await loadCustomReviewInstructions(config, baseDir);
        const reviewedSha = await readCurrentHeadSha(baseDir);
        if (!reviewedSha) {
          throw new Error('Could not determine current HEAD SHA for plan review guide.');
        }

        const baseSha = await resolvePlanReviewBaseSha(context, baseDir);
        const diffCatalog = usesManagedWorkspace
          ? await loadReviewGuideDiffCatalog({
              baseDir,
              baseSha,
              reviewedSha,
            })
          : buildReviewGuideDiffCatalog(context.diffResult.diffContent);

        const review = createReview(db, {
          projectId,
          planUuid: planRow.uuid,
          baseBranch: context.diffResult.baseBranch,
          status: 'in_progress',
        });

        const metadata = buildPlanMetadata(planId, planRow.uuid, context, reviewedSha);
        const planTag = `plan ${planId} (${planRow.uuid})`;

        await runReviewGuideWorkflow({
          db,
          config,
          baseDir,
          review,
          metadata,
          baseSha,
          reviewedSha,
          diffCatalog,
          executorSelection: reviewSelection,
          executorTerminalInput: effectiveTerminalInput,
          executorNoninteractive: !reviewInteractive,
          customInstructions,
          verbose: options.verbose,
          model: options.model,
          filesReviewed: context.diffResult.changedFiles.length,
          completionLabel: `plan ${planId}`,
          planTag,
        });
      },
    });
  } finally {
    setDeferSignalExit(false);
    if (isShuttingDown()) {
      process.exit(getSignalExitCode() ?? 1);
    }
  }
}
