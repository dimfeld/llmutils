import { getGitRoot, getTrunkBranch } from '../../common/git.js';
import { boldMarkdownHeaders, log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import type { TimConfig } from '../configSchema.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { generateDiffForReview, type DiffResult } from '../incremental_review.js';
import type { PlanSchema } from '../planSchema.js';
import { materializePlan } from '../plan_materialize.js';
import { parsePlanIdFromCliArg, resolvePlanByNumericId } from '../plans.js';
import { resolveRepoRoot } from '../plan_repo_root.js';

interface SimplifyOptions {
  executor?: string;
  model?: string;
  baseDir?: string;
  nonInteractive?: boolean;
  terminalInput?: boolean;
}

interface SimplifyPromptOptions {
  include?: string[];
  exclude?: string[];
}

function buildSimplifyPrompt(
  planData: PlanSchema,
  diffResult: DiffResult,
  options: SimplifyPromptOptions = {}
): string {
  const parts: string[] = [];
  const { include, exclude } = options;
  const diffBase = diffResult.mergeBaseCommit ?? diffResult.baseBranch;

  parts.push(
    'The implementation work for this plan is complete. Perform one final code simplification pass over the changes introduced by this plan.\n',
    `# Plan: ${planData.title}\n`
  );

  if (planData.goal) {
    parts.push(`## Goal\n${planData.goal}\n`);
  }

  parts.push(
    '## Diff Scope\n',
    `The changes are scoped to \`git diff ${diffBase}...HEAD\`. Run \`git diff ${diffBase}...HEAD\` yourself to inspect specifics. Do not review unrelated code outside this diff except when checking existing utilities or conventions needed to simplify the changed code.\n`,
    '## Changed Files\n'
  );

  for (const file of diffResult.changedFiles) {
    parts.push(`- ${file}`);
  }

  parts.push(
    '\n## Simplification Review\n',
    'Launch THREE specialized review agents in parallel using your Task tool or equivalent. Each agent should inspect the changes in the diff and report concrete simplification opportunities only for its focus area:\n',
    '**Code Reuse** - Duplicated logic, redundant patterns. Examples: existing utilities that could replace new code; duplicate functions across files; hand-rolled string manipulation or path handling where helpers already exist; inline logic that should use existing abstractions.\n',
    '**Code Quality** - Readability, structure, conventions. Examples: redundant state; parameter sprawl; copy-paste with slight variation; leaky abstractions; "stringly-typed" code using raw strings where typed constants exist.\n',
    '**Efficiency** - Performance and resource usage. Examples: unnecessary work; missed concurrency opportunities; hot-path bloat (expensive logic in tight loops); time-of-check/time-of-use (TOCTOU) anti-patterns; memory leaks; overly broad operations like reading entire files when only portions are needed.\n',
    'After all three agents finish, aggregate their findings. Fix each valid issue directly in the codebase and silently drop findings you determine are false positives.\n',
    'Before finishing, run `bun run check` and `bun run test`. Both must pass. If a simplification breaks either command, repair it or revert that specific fix.\n',
    "Print a brief summary of what changed, or exactly 'no changes — code already clean' if no changes were needed."
  );

  if (include && include.length > 0) {
    parts.push('\n## Files to Include');
    parts.push('Only edit files matching these descriptions:');
    for (const pattern of include) {
      parts.push(`- ${pattern}`);
    }
  }

  if (exclude && exclude.length > 0) {
    parts.push('\n## Files to Exclude');
    parts.push('Never edit files matching these descriptions:');
    for (const pattern of exclude) {
      parts.push(`- ${pattern}`);
    }
  }

  return parts.join('\n');
}

export async function runSimplify(
  planData: PlanSchema,
  planFilePath: string,
  effectiveConfig: TimConfig,
  options: SimplifyOptions = {}
): Promise<void> {
  const baseDir = options.baseDir ?? (await getGitRoot()) ?? process.cwd();
  const baseBranch = await getTrunkBranch(baseDir);
  const diffResult = await generateDiffForReview(baseDir, { baseBranch });

  if (!diffResult.hasChanges) {
    log('no changes vs base — skipping simplify');
    return;
  }

  const prompt = buildSimplifyPrompt(planData, diffResult, {
    include: effectiveConfig.simplify?.include,
    exclude: effectiveConfig.simplify?.exclude,
  });

  const executorName =
    options.executor ||
    effectiveConfig.simplify?.executor ||
    effectiveConfig.defaultExecutor ||
    DEFAULT_EXECUTOR;

  const model =
    options.model ||
    effectiveConfig.simplify?.model ||
    effectiveConfig.models?.execution ||
    defaultModelForExecutor(executorName, 'execution');

  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir,
    model,
    noninteractive: options.nonInteractive ? true : undefined,
    terminalInput: options.terminalInput,
  };

  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, effectiveConfig);

  log(boldMarkdownHeaders('\n## Simplifying Code\n'));
  await executor.execute(prompt, {
    planId: planData.id?.toString() ?? 'unknown',
    planTitle: planData.title ?? 'Simplify Code',
    planFilePath,
    executionMode: 'bare',
    captureOutput: 'none',
  });
}

export async function handleSimplifyCommand(
  planIdArg: string | number | undefined,
  options: SimplifyOptions,
  command: { parent: { opts: () => { config?: string } } }
) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);

  if (planIdArg === undefined) {
    throw new Error('A numeric plan ID is required');
  }

  const planId = typeof planIdArg === 'number' ? planIdArg : parsePlanIdFromCliArg(planIdArg);
  const repoRoot = await resolveRepoRoot(globalOpts.config, (await getGitRoot()) || process.cwd());
  const { plan, planPath } = await resolvePlanByNumericId(planId, repoRoot);
  const resolvedPlanFile = planPath ?? (await materializePlan(plan.id, repoRoot));

  await runSimplify(plan, resolvedPlanFile, config, {
    executor: options.executor,
    model: options.model,
    baseDir: repoRoot,
    nonInteractive: options.nonInteractive,
    terminalInput: options.terminalInput,
  });

  log('\nSimplify pass complete');
}
