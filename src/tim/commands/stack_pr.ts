import { detectExistingPrUrl } from './create_pr.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import {
  parsePlanIdFromCliArg,
  PlanNotFoundError,
  resolvePlanByBranch,
  resolvePlanByNumericId,
} from '../plans.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { runPrStacking, type PrStackingPlan } from '../pr_stacking/runner.js';

interface RootCommandLike {
  parent?: RootCommandLike;
  opts?: () => {
    config?: string;
  };
}

interface PrStackCommandOptions {
  workspace?: string;
  autoWorkspace?: boolean;
  nonInteractive?: boolean;
  terminalInput?: boolean;
  base?: string;
}

function getRootOptions(command: RootCommandLike | undefined): { config?: string } {
  let current = command;
  while (current?.parent) {
    current = current.parent;
  }

  return current?.opts?.() ?? {};
}

async function resolvePlanByIdOrBranch(
  planIdOrBranch: string,
  repoRoot: string,
  baseBranch: string | undefined
): Promise<{
  plan: PrStackingPlan;
  planPath: string | null;
}> {
  const normalizedArgument = planIdOrBranch.trim();
  if (/^\d+$/.test(normalizedArgument)) {
    return resolvePlanByNumericId(parsePlanIdFromCliArg(normalizedArgument), repoRoot);
  }

  try {
    return await resolvePlanByBranch(normalizedArgument, repoRoot);
  } catch (error) {
    if (!(error instanceof PlanNotFoundError) || baseBranch === undefined) {
      throw error;
    }

    return {
      plan: { branch: normalizedArgument },
      planPath: null,
    };
  }
}

export async function handlePrStackCommand(
  planIdOrBranch: string,
  options: Record<string, unknown>,
  command: RootCommandLike
): Promise<void> {
  const { workspace, autoWorkspace, nonInteractive, terminalInput, base } =
    options as PrStackCommandOptions;
  const baseBranch = base?.trim() || undefined;
  const globalOpts = getRootOptions(command);
  const repoRoot = await resolveRepoRoot(globalOpts.config, process.cwd());
  const config = await loadEffectiveConfig(globalOpts.config, { cwd: repoRoot });
  const { plan, planPath } = await resolvePlanByIdOrBranch(planIdOrBranch, repoRoot, baseBranch);

  if (!plan.branch) {
    throw new Error(`Plan ${plan.id ?? planIdOrBranch} does not have a branch for PR stacking.`);
  }

  const mainPrUrl = plan.pullRequest?.[0] ?? (await detectExistingPrUrl(plan.branch, repoRoot));
  if (!mainPrUrl) {
    throw new Error(`No pull request found for plan branch "${plan.branch}".`);
  }

  const effectiveTerminalInput =
    terminalInput !== false &&
    config.terminalInput !== false &&
    nonInteractive !== true &&
    process.stdin.isTTY;

  await runWithHeadlessAdapterIfEnabled({
    enabled: !isTunnelActive(),
    command: 'pr-stack',
    interactive: effectiveTerminalInput,
    plan: {
      id: plan.id,
      uuid: plan.uuid,
      title: plan.title,
    },
    callback: async () => {
      let currentBaseDir = repoRoot;
      let currentPlanFile = planPath ?? '';

      if (workspace !== undefined || autoWorkspace === true) {
        const workspaceResult = await setupWorkspace(
          {
            workspace,
            autoWorkspace,
            nonInteractive,
            planId: plan.id,
            planUuid: plan.uuid,
            checkoutBranch: plan.branch,
            createBranch: false,
            allowPrimaryWorkspaceWhenLocked: true,
          },
          currentBaseDir,
          currentPlanFile || undefined,
          config,
          'tim pr stack'
        );

        currentBaseDir = workspaceResult.baseDir;
        currentPlanFile = workspaceResult.planFile;
      }

      await runPrStacking({
        plan,
        planFilePath: currentPlanFile,
        mainPrUrl,
        baseDir: currentBaseDir,
        repoPath: repoRoot,
        config,
        terminalInput: effectiveTerminalInput,
        manual: true,
        baseBranch,
      });
    },
  });
}
