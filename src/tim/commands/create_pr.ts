import { syncPlanPrLinks } from '../../common/github/pr_status_service.js';
import {
  ensureJjPublishedCommitsHaveDescriptions,
  getMergeBase,
  getTrunkBranch,
  getUsingJj,
} from '../../common/git.js';
import { log, warn } from '../../logging.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { LATEST_GPT5_MINI_MODEL } from '../constants.js';
import { loadEffectiveConfig } from '../configLoader.js';
import type { TimConfig } from '../configSchema.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { getDatabase } from '../db/database.js';
import { buildExecutorAndLog } from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { getLegacyAwareSearchDir } from '../path_resolver.js';
import { materializeRelatedPlans } from '../plan_materialize.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import type { PlanSchema } from '../planSchema.js';
import { loadPlansFromDb } from '../plans_db.js';
import { resolvePlanByNumericId, writePlanFile } from '../plans.js';
import {
  resolveEffectivePlanBase,
  resolveEffectivePlanBaseWithSource,
} from '../plans/base_plan_resolution.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import { buildTimWorkspaceCommandEnvironmentOptionsForPath } from '../environment_options.js';

interface RootCommandLike {
  parent?: RootCommandLike;
  opts?: () => {
    config?: string;
  };
}

export interface PrCreationPromptOptions {
  vcsType: 'git' | 'jj';
  baseBranch: string;
  baseRef?: string;
  planTitle?: string;
  planId?: number;
  planDetails?: string;
  issueRef?: string;
  prCreationConfig?: {
    draft?: boolean;
    titlePrefix?: string;
  };
  siblingPlans?: PlanScopeSummary[];
}

export interface PlanScopeSummary {
  id: number;
  title: string;
  status?: string;
  goal?: string;
}

export interface AutoCreatePrOptions {
  model?: string;
  executor?: string;
  baseDir: string;
  repoPath?: string;
  config: TimConfig;
  terminalInput?: boolean;
}

interface CreatePrCommandOptions {
  model?: string;
  executor?: string;
  workspace?: string;
  autoWorkspace?: boolean;
  nonInteractive?: boolean;
  terminalInput?: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const CREATE_PR_ALLOWED_BASH_TOOLS = [
  'Bash(gh pr create:*)',
  'Bash(jj bookmark track:*)',
  'Bash(jj bookmark list:*)',
  'Bash(jj git push --branch:*)',
];
const CLAUDE_CODE_EXECUTOR_NAME = 'claude-code';

function defaultSmallModelForExecutor(executorName: string): string {
  return executorName === 'codex-cli' ? LATEST_GPT5_MINI_MODEL : 'haiku';
}

function getRootOptions(command: RootCommandLike | undefined): { config?: string } {
  let current = command;
  while (current?.parent) {
    current = current.parent;
  }

  return current?.opts?.() ?? {};
}

function appendPlanContext(prompt: string[], options: PrCreationPromptOptions): void {
  const issueRef = options.issueRef?.trim();
  const planDetails = options.planDetails?.trim();
  const planContext: string[] = [];

  if (options.planId != null) {
    planContext.push(`Plan ID: ${options.planId}`);
  }
  if (options.planTitle?.trim()) {
    planContext.push(`Plan title: ${options.planTitle.trim()}`);
  }
  if (issueRef) {
    planContext.push(`Issue reference: ${issueRef}`);
  }
  if (planDetails) {
    planContext.push(`Plan details:\n${planDetails}`);
  }
  if (options.siblingPlans && options.siblingPlans.length > 0) {
    planContext.push(
      [
        'Sibling plans that may own adjacent or follow-up scope:',
        ...options.siblingPlans.map((sibling) => {
          const status = sibling.status?.trim() ? ` [${sibling.status.trim()}]` : '';
          const goal = sibling.goal?.trim() ? ` - ${sibling.goal.trim()}` : '';
          return `- Plan ${sibling.id}: ${sibling.title}${status}${goal}`;
        }),
      ].join('\n')
    );
  }

  if (planContext.length > 0) {
    prompt.push('## Plan Context', '', ...planContext, '');
  }
}

export function buildPrCreationPrompt(options: PrCreationPromptOptions): string {
  const createAsDraft = options.prCreationConfig?.draft !== false;
  const titlePrefix = options.prCreationConfig?.titlePrefix?.trim();
  const baseRef = options.baseRef?.trim() || options.baseBranch;
  const branchNameCommand =
    options.vcsType === 'jj'
      ? "jj log -r 'latest(heads(ancestors(@) & bookmarks()), 1)' --limit 1 --no-graph -T local_bookmarks | tr -d '*'"
      : 'git rev-parse --abbrev-ref HEAD';
  const statusCommand = options.vcsType === 'jj' ? 'jj status' : 'git status --short --branch';
  const commitCommand =
    options.vcsType === 'jj'
      ? 'jj commit -m "<message>"'
      : 'git add -A && git commit -m "<message>"';
  const diffSummaryCommand =
    options.vcsType === 'jj'
      ? `jj diff -r '${baseRef}::@' -s | grep '^[MA]' | nl`
      : `git diff --name-status ${baseRef}...HEAD | grep '^[AM]' | nl`;
  const historyCommand =
    options.vcsType === 'jj'
      ? `jj log -r '${baseRef}::@' --summary`
      : `git log --oneline ${baseRef}..HEAD`;
  const pushCommand =
    options.vcsType === 'jj'
      ? 'jj bookmark track <branch-name> --remote origin && jj git push --branch <branch-name>'
      : 'git push -u origin <branch-name>';
  const draftFlag = createAsDraft ? '--draft ' : '';
  const titlePrefixLine = titlePrefix
    ? `- Prefix the PR title with: ${titlePrefix}`
    : '- No title prefix is required unless it improves clarity.';
  const trimmedPlanTitle = options.planTitle?.trim();
  const prTitleInstruction = trimmedPlanTitle
    ? `Use this exact plan title as the PR title: "${trimmedPlanTitle}". If a title prefix is required, prepend it to that title.`
    : 'If a plan title is available in the Plan Context section, use it as the PR title. If a title prefix is required, prepend it to that title.';

  const prompt: string[] = [
    'Please do the following:',
    '',
    'Important: do not ask for confirmation at any point. Push the branch and create the PR directly.',
    '',
    '## Step 1: Examine Repository State',
    '',
    `1a. Working copy status:\n\n!\`${statusCommand}\``,
    '',
    `1b. Current commit and branch:\n\n!\`${
      options.vcsType === 'jj' ? 'jj log -r @ -n 1' : 'git log -n 1 --decorate'
    }\``,
    '',
    `1c. The current bookmark/branch name is: !\`${branchNameCommand}\``,
    '',
    '   - Store this as `<branch-name>` for use in subsequent steps',
    `   - Base branch is \`${options.baseBranch}\` and comparison base is \`${baseRef}\``,
    '',
    `1d. Commit history on the branch:\n\n!\`${historyCommand}\``,
    '',
    '## Step 2: Examine Changes',
    '',
    'The files that will be included in the PR are:',
    '',
    `!\`${diffSummaryCommand}\``,
    '',
    'Group the files by functional area and examine each file diff carefully. Use per-file diff commands as needed. Do not run any lint or tests, you are only trying to figure out what the changes do.',
    `For each file, use ${options.vcsType === 'jj' ? "`jj diff -r '" + baseRef + "::@' <file>`" : '`git diff ' + baseRef + '...HEAD -- <file>`'}.`,
    'If you find an issue tracker reference in plan files or code comments, include it in the PR title/body where appropriate.',
    '',
    '## Step 3: Commit New Changes (if needed)',
    '',
    `If there are uncommitted changes, create a commit using \`${commitCommand}\` with a concise subject and bullet list body.`,
    'If there are no uncommitted changes, skip this step.',
    '',
    '## Step 4: Push Changes Without Confirmation',
    '',
    `Push with: \`${pushCommand}\``,
    '',
    '## Step 5: Create or Update Pull Request',
    '',
    '5a. Check whether a PR already exists:',
    '```bash',
    'gh pr list --head <branch-name>',
    '```',
    '',
    '5b. If a PR exists, inspect and update it with `gh pr edit` only when title/body are stale.',
    'Preserve any existing issue-closing tags in the body.',
    prTitleInstruction,
    '',
    `5c. If no PR exists, create one directly with \`gh pr create ${draftFlag}--head <branch-name> --base ${options.baseBranch}\` and include:`,
    '- Summary section with bullet points',
    '- In the Summary section, include an "Out of scope" subsection. It must describe anything explicitly out of scope in the plan and any adjacent work assigned to sibling plans from the Plan Context. If nothing is out of scope and no sibling-plan scope is listed, write "None identified."',
    '- Changes section listing important files/modules',
    '- Test plan section with checkboxes',
    '- Manual Testing Runbooks section copied from the Plan Context when the plan details contain "Manual Testing Runbooks"; preserve the runbook titles, steps, and expected outcomes so reviewers can manually walk through the delivered feature',
    trimmedPlanTitle
      ? `- PR title: "${trimmedPlanTitle}"`
      : '- PR title: use the exact plan title from the Plan Context section',
    titlePrefixLine,
    '- Include issue references when available (for Linear keep the full key, e.g. DF-123)',
    '',
    'Do not include generated-by or co-author lines. Do not make any changes to the code. You are only creating the PR right now.',
  ];

  appendPlanContext(prompt, options);
  return prompt.join('\n');
}

async function runCommand(args: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

export async function detectExistingPrUrl(branch: string, baseDir: string): Promise<string | null> {
  const result = await runCommand(['gh', 'pr', 'list', '--head', branch, '--json', 'url'], baseDir);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Failed to query PR list with gh');
  }

  const parsed = JSON.parse(result.stdout || '[]') as Array<{ url?: string }>;
  const url = parsed.find((p) => p.url?.trim())?.url?.trim();
  return url && url.length > 0 ? url : null;
}

/**
 * Persist a PR URL in the plan file and plan_pr junction table.
 * Re-reads the plan from DB/file to avoid overwriting concurrent changes.
 */
async function persistPrUrl(
  planId: number | undefined,
  planUuid: string | undefined,
  planPath: string | null,
  prUrl: string,
  baseDir: string
): Promise<void> {
  if (!planUuid) {
    throw new Error(`Plan ${planId ?? '(unknown)'} is missing UUID and cannot sync plan_pr links`);
  }

  if (planId == null) {
    throw new Error(`Plan ${planUuid ?? '(unknown)'} is missing a numeric ID`);
  }
  const { plan: freshPlan, planPath: freshPlanPath } = await resolvePlanByNumericId(
    planId,
    baseDir
  );

  const actualPlanPath = freshPlanPath ?? planPath;
  const nextPullRequests = [...new Set([...(freshPlan.pullRequest ?? []), prUrl])];
  const updatedPlan: PlanSchema = {
    ...freshPlan,
    pullRequest: nextPullRequests,
  };
  if (actualPlanPath) {
    await writePlanFile(actualPlanPath, updatedPlan, { cwdForIdentity: baseDir });
  }

  const db = getDatabase();
  await syncPlanPrLinks(db, planUuid, nextPullRequests);
}

export async function detectAndStorePrUrl(
  planId: number | undefined,
  planUuid: string | undefined,
  planPath: string | null,
  branch: string,
  baseDir: string
): Promise<string | null> {
  const prUrl = await detectExistingPrUrl(branch, baseDir);
  if (!prUrl) {
    return null;
  }

  await persistPrUrl(planId, planUuid, planPath, prUrl, baseDir);
  return prUrl;
}

export async function resolveEffectivePrBase(
  plan: PlanSchema,
  baseDir: string,
  config: TimConfig
): Promise<string> {
  return resolveEffectivePlanBase({ plan, baseDir, config });
}

async function collectSiblingPlanScope(
  plan: PlanSchema,
  baseDir: string,
  repoPath?: string
): Promise<PlanScopeSummary[]> {
  if (!plan.id || !plan.parent) {
    return [];
  }

  try {
    const { gitRoot, repositoryId } = await getRepositoryIdentity({ cwd: baseDir });
    const searchDir = getLegacyAwareSearchDir(gitRoot, repoPath ?? baseDir);
    const { plans } = loadPlansFromDb(searchDir, repositoryId);

    return Array.from(plans.values())
      .filter(
        (candidate): candidate is PlanSchema & { id: number } =>
          typeof candidate.id === 'number' &&
          candidate.id !== plan.id &&
          candidate.parent === plan.parent
      )
      .toSorted((a, b) => (a.id ?? 0) - (b.id ?? 0))
      .map((candidate) => ({
        id: candidate.id,
        title: candidate.title || `Plan ${candidate.id}`,
        status: candidate.status,
        goal: candidate.goal,
      }));
  } catch (err) {
    warn(`Could not load sibling plan scope for PR prompt: ${err as Error}`);
    return [];
  }
}

async function runPrCreationExecutor(
  plan: PlanSchema,
  planPath: string | null,
  options: AutoCreatePrOptions
): Promise<void> {
  const usingJj = await getUsingJj(options.baseDir);
  if (usingJj) {
    await ensureJjPublishedCommitsHaveDescriptions(options.baseDir);
  }
  const baseResolution = await resolveEffectivePlanBaseWithSource({
    plan,
    baseDir: options.baseDir,
    config: options.config,
    fetchBasePlanRemote: !usingJj,
  });
  const baseBranch = baseResolution.baseBranch;
  const trunkBranch = await getTrunkBranch(options.baseDir);
  const jjBaseRevset =
    baseBranch === trunkBranch
      ? 'trunk()'
      : baseResolution.source === 'basePlan'
        ? `${baseBranch}@origin`
        : `latest(present(${baseBranch}) | present(${baseBranch}@origin))`;
  const baseRef = usingJj ? `latest(ancestors(${jjBaseRevset}) & ancestors(@))` : undefined;
  let mergeBase: string | undefined;
  if (!usingJj) {
    const resolved = await getMergeBase(options.baseDir, baseBranch);
    if (!resolved) {
      throw new Error(`Failed to resolve merge-base against origin/${baseBranch}`);
    }
    mergeBase = resolved;
  }
  const issueRef = plan.issue?.[0];
  if (planPath && plan.id) {
    await materializeRelatedPlans(plan.id, options.baseDir);
  }
  const siblingPlans = await collectSiblingPlanScope(plan, options.baseDir, options.repoPath);
  const prPrompt = buildPrCreationPrompt({
    vcsType: usingJj ? 'jj' : 'git',
    baseBranch,
    baseRef: baseRef ?? mergeBase ?? undefined,
    planTitle: plan.title,
    planId: plan.id,
    planDetails: plan.details,
    issueRef,
    prCreationConfig: options.config.prCreation,
    siblingPlans,
  });

  const executorName =
    options.executor ?? options.config.defaultExecutor ?? CLAUDE_CODE_EXECUTOR_NAME;
  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: options.baseDir,
    model: options.model ?? defaultSmallModelForExecutor(executorName),
    terminalInput: options.terminalInput ?? false,
    disableInactivityTimeout: true,
    timEnvironment: buildTimWorkspaceCommandEnvironmentOptionsForPath(
      options.config,
      options.baseDir,
      {
        planId: plan.id,
        planUuid: plan.uuid,
        planFilePath: planPath,
        branch: plan.branch,
      },
      options.repoPath ?? options.baseDir
    ),
  };
  const executorOptions =
    executorName === CLAUDE_CODE_EXECUTOR_NAME
      ? {
          allowedTools: [
            ...new Set([
              ...((options.config.executors as Record<string, any>)?.[CLAUDE_CODE_EXECUTOR_NAME]
                ?.allowedTools ?? []),
              ...CREATE_PR_ALLOWED_BASH_TOOLS,
            ]),
          ],
        }
      : {};
  const executor = buildExecutorAndLog(
    executorName,
    sharedExecutorOptions,
    options.config,
    executorOptions
  );

  await executor.execute(prPrompt, {
    planId: plan.id != null ? String(plan.id) : (plan.uuid ?? 'pr-create'),
    planTitle: plan.title || 'Create PR',
    planFilePath: planPath ?? '',
    executionMode: 'bare',
  });
}

/**
 * Create or update a PR for a plan. Always runs the executor which handles
 * both creating new PRs and updating existing ones.
 * Used by the `tim pr create` CLI command.
 */
export async function createOrUpdatePrForPlan(
  plan: PlanSchema,
  planPath: string | null,
  options: AutoCreatePrOptions
): Promise<string | null> {
  if (!plan.branch) {
    warn(`Plan ${plan.id ?? '(unknown)'} has no branch, cannot create PR`);
    return null;
  }

  if (!plan.uuid) {
    warn(`Plan ${plan.id ?? '(unknown)'} is missing UUID, cannot persist PR URL`);
    return null;
  }

  await runPrCreationExecutor(plan, planPath, options);
  return detectAndStorePrUrl(plan.id, plan.uuid, planPath, plan.branch, options.baseDir);
}

/**
 * Auto-create a PR for a plan if one doesn't already exist.
 * Checks for existing PR first and only invokes the executor when needed.
 * Used by the agent completion auto-create hook.
 */
export async function autoCreatePrForPlan(
  plan: PlanSchema,
  planPath: string | null,
  options: AutoCreatePrOptions
): Promise<string | null> {
  if (!plan.branch) {
    return null;
  }

  if (!plan.uuid) {
    warn(`Plan ${plan.id} is missing UUID, cannot persist PR URL`);
    return null;
  }

  // Check if PR already exists — if so, just store the URL and return
  const existingPrUrl = await detectExistingPrUrl(plan.branch, options.baseDir);
  if (existingPrUrl) {
    await persistPrUrl(plan.id, plan.uuid, planPath, existingPrUrl, options.baseDir);
    return existingPrUrl;
  }

  // No PR exists, create one
  await runPrCreationExecutor(plan, planPath, options);
  return detectAndStorePrUrl(plan.id, plan.uuid, planPath, plan.branch, options.baseDir);
}

export async function handleCreatePrCommand(
  planId: number,
  options: Record<string, unknown>,
  command: RootCommandLike
): Promise<void> {
  const { model, executor, workspace, autoWorkspace, nonInteractive, terminalInput } =
    options as CreatePrCommandOptions;

  const globalOpts = getRootOptions(command);
  const repoRoot = await resolveRepoRoot(globalOpts.config, process.cwd());
  const config = await loadEffectiveConfig(globalOpts.config, { cwd: repoRoot });

  const effectiveTerminalInput =
    terminalInput !== false &&
    config.terminalInput !== false &&
    nonInteractive !== true &&
    process.stdin.isTTY;
  const { plan, planPath } = await resolvePlanByNumericId(planId, repoRoot);

  if (!plan.branch) {
    throw new Error(
      `Plan ${plan.id ?? planId} does not have a branch. Create one before PR creation.`
    );
  }

  let prUrl: string | null = null;

  await runWithHeadlessAdapterIfEnabled({
    enabled: !isTunnelActive(),
    command: 'pr-create',
    interactive: effectiveTerminalInput,
    plan: {
      id: plan.id,
      uuid: plan.uuid,
      title: plan.title,
    },
    callback: async () => {
      let currentBaseDir = repoRoot;
      let currentPlanFile = planPath ?? '';

      const workspaceMode = workspace !== undefined || autoWorkspace === true;
      if (workspaceMode) {
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
          'tim pr create'
        );

        currentBaseDir = workspaceResult.baseDir;
        currentPlanFile = workspaceResult.planFile;
      }

      prUrl = await createOrUpdatePrForPlan(plan, currentPlanFile || null, {
        baseDir: currentBaseDir,
        model,
        executor,
        config,
        terminalInput: effectiveTerminalInput,
        repoPath: repoRoot,
      });
    },
  });

  if (prUrl === null) {
    throw new Error('No PR was found or created for this plan branch.');
  }

  log('PR available:', prUrl);
}
