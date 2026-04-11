import { syncPlanPrLinks } from '../../common/github/pr_status_service.js';
import { getMergeBase, getUsingJj } from '../../common/git.js';
import { log, warn } from '../../logging.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { loadEffectiveConfig } from '../configLoader.js';
import type { TimConfig } from '../configSchema.js';
import { getDatabase } from '../db/database.js';
import { buildExecutorAndLog } from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { resolvePlan } from '../plan_display.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import type { PlanSchema } from '../planSchema.js';
import { writePlanFile } from '../plans.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';

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
}

export interface AutoCreatePrOptions {
  model?: string;
  executor?: string;
  baseDir: string;
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
    '## Step 2: Review Changes',
    '',
    'The files that will be included in the PR are:',
    '',
    `!\`${diffSummaryCommand}\``,
    '',
    'Group the files by functional area and review each file diff carefully. Use per-file diff commands as needed.',
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
    '',
    `5c. If no PR exists, create one directly with \`gh pr create ${draftFlag}--head <branch-name> --base ${options.baseBranch}\` and include:`,
    '- Summary section with bullet points',
    '- Changes section listing important files/modules',
    '- Test plan section with checkboxes',
    '- A concise, specific PR title',
    titlePrefixLine,
    '- Include issue references when available (for Linear keep the full key, e.g. DF-123)',
    '',
    'Do not include generated-by or co-author lines.',
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
  planId: string | number | undefined,
  planUuid: string | undefined,
  planPath: string | null,
  prUrl: string,
  baseDir: string
): Promise<void> {
  if (!planUuid) {
    throw new Error(`Plan ${planId ?? '(unknown)'} is missing UUID and cannot sync plan_pr links`);
  }

  const planLookupArg = planId != null ? String(planId) : planUuid;
  const { plan: freshPlan, planPath: freshPlanPath } = await resolvePlan(planLookupArg, {
    gitRoot: baseDir,
  });

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
  planId: string | number | undefined,
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

async function runPrCreationExecutor(
  plan: PlanSchema,
  planPath: string | null,
  options: AutoCreatePrOptions
): Promise<void> {
  const usingJj = await getUsingJj(options.baseDir);
  const baseBranch = plan.baseBranch?.trim() || 'main';
  const baseRef = usingJj ? 'latest(ancestors(trunk()) & ancestors(@))' : undefined;
  let mergeBase: string | undefined;
  if (!usingJj) {
    const resolved = await getMergeBase(options.baseDir, baseBranch);
    if (!resolved) {
      throw new Error(`Failed to resolve merge-base against origin/${baseBranch}`);
    }
    mergeBase = resolved;
  }
  const issueRef = plan.issue?.[0];
  const prPrompt = buildPrCreationPrompt({
    vcsType: usingJj ? 'jj' : 'git',
    baseBranch,
    baseRef: baseRef ?? mergeBase ?? undefined,
    planTitle: plan.title,
    planId: plan.id,
    planDetails: plan.details,
    issueRef,
    prCreationConfig: options.config.prCreation,
  });

  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: options.baseDir,
    model: options.model ?? 'haiku',
    terminalInput: options.terminalInput ?? false,
    disableInactivityTimeout: true,
  };
  const executorOptions =
    (options.executor ?? CLAUDE_CODE_EXECUTOR_NAME) === CLAUDE_CODE_EXECUTOR_NAME
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
    options.executor ?? CLAUDE_CODE_EXECUTOR_NAME,
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
  planArg: string,
  options: Record<string, unknown>,
  command: RootCommandLike
): Promise<void> {
  const { model, executor, workspace, autoWorkspace, nonInteractive, terminalInput } =
    options as CreatePrCommandOptions;

  const globalOpts = getRootOptions(command);
  const repoRoot = await resolveRepoRootForPlanArg(planArg, process.cwd(), globalOpts.config);
  const config = await loadEffectiveConfig(globalOpts.config, { cwd: repoRoot });

  const effectiveTerminalInput =
    terminalInput !== false &&
    config.terminalInput !== false &&
    nonInteractive !== true &&
    process.stdin.isTTY === true;
  const { plan, planPath } = await resolvePlan(planArg, {
    gitRoot: repoRoot,
    configPath: globalOpts.config,
  });

  if (!plan.branch) {
    throw new Error(
      `Plan ${plan.id ?? planArg} does not have a branch. Create one before PR creation.`
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
      });
    },
  });

  if (!prUrl) {
    throw new Error('No PR was found or created for this plan branch.');
  }

  log(`PR available: ${prUrl}`);
}
