import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import { spawnAndLogOutput } from '../../common/process.js';
import { getCurrentCommitHash, getGitRoot, getTrunkBranch, getUsingJj } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanFromDbOrSyncFile } from '../ensure_plan_in_db.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import type { PlanSchema } from '../planSchema.js';
import { generateBranchNameFromPlan } from './branch.js';
import { findNextPlanFromDb } from './plan_discovery.js';
import { pullWorkspaceRefIfExists } from './workspace.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';

export interface RebaseCommandOptions {
  current?: boolean;
  next?: boolean;
  executor?: string;
  model?: string;
  push?: boolean;
  terminalInput?: boolean;
  workspace?: string;
  autoWorkspace?: boolean;
  newWorkspace?: boolean;
}

interface RebasePlanContext {
  plan: PlanSchema;
  planFile: string;
  repoRoot: string;
}

const GIT_CONFLICT_PROMPT = `Run \`git status\` and \`git diff\` to see the current state of the repository.

This repository is in the middle of a rebase and has conflicts that need to be resolved.

Examine the conflicts and make a todo list of conflicts to fix.

For each conflicting file:
1. Examine the conflict markers and understand both sides
2. Look at the git log for both branches to understand the context of each change
3. Resolve the conflict in the file
4. Run \`git add <file>\` to mark it as resolved
5. After all conflicts in the current commit are resolved, run \`git rebase --continue\`

Note: There may be multiple commits that conflict. After running \`git rebase --continue\`, another commit may have conflicts. Repeat the process until the rebase is complete.

As you make edits, describe your reasoning. If it is not clear to you how a conflict should be resolved, stop and ask me what to do, and I will try to provide guidance or resolve it myself.`;

const JUJUTSU_CONFLICT_PROMPT = `Run \`jj status\` to see the current state of the repository.

This repository was just rebased and has conflicts that need to be resolved.

Examine the conflicts and make a todo list of conflicts to fix.

For each conflict, examine each side and the commits lower in the commit tree that modified the lines to get the context for each one. Unless there's an obvious merge, these conflicts were likely caused by rebasing this branch on top of another (likely main), and so the conflicting changes from the other branch are probably on "main" somewhere.

As you make edits, describe your reasoning. If it is not clear to you how a conflict should be resolved, stop and ask me what to do, and I will try to provide guidance or resolve it myself.

When you use \`jj squash\` as part of this process, do not give it any arguments since the squash message will overwrite the original commit message.`;

export async function handleRebaseCommand(
  planFile: string | undefined,
  options: RebaseCommandOptions,
  command: Command
): Promise<void> {
  const globalOpts = command.parent?.opts() ?? {};
  const config = await loadEffectiveConfig(globalOpts.config);
  const fallbackRoot = (await getGitRoot()) || process.cwd();
  const initialRepoRoot = await resolveRepoRootForPlanArg(
    planFile ?? '',
    fallbackRoot,
    globalOpts.config
  );
  const resolved = await resolveRebasePlan(planFile, options, initialRepoRoot, globalOpts.config);

  const branchName = resolved.plan.branch ?? generateBranchNameFromPlan(resolved.plan);
  const workspaceMode =
    options.workspace !== undefined ||
    options.autoWorkspace === true ||
    options.newWorkspace === true;

  let baseDir = resolved.repoRoot;
  let currentPlanFile = resolved.planFile;

  if (workspaceMode) {
    const workspaceResult = await setupWorkspace(
      {
        workspace: options.workspace,
        autoWorkspace: options.autoWorkspace,
        newWorkspace: options.newWorkspace,
        createBranch: false,
        planId: resolved.plan.id,
        planUuid: resolved.plan.uuid,
        base: branchName,
        allowPrimaryWorkspaceWhenLocked: true,
      },
      baseDir,
      currentPlanFile || undefined,
      config,
      'tim rebase'
    );
    baseDir = workspaceResult.baseDir;
    currentPlanFile = workspaceResult.planFile;
  }

  const isJj = await getUsingJj(baseDir);
  const trunkBranch = await getTrunkBranch(baseDir);

  if (!workspaceMode) {
    console.log(`Checking out ${branchName}...`);
    const checkedOut = await pullWorkspaceRefIfExists(
      baseDir,
      branchName,
      'origin',
      currentPlanFile
    );
    if (!checkedOut) {
      throw new Error(`Branch "${branchName}" does not exist locally or on origin.`);
    }
  }

  const beforeRevision = await getRebaseTargetRevision(baseDir, branchName, isJj);
  const rebaseTarget = isJj ? trunkBranch : `origin/${trunkBranch}`;

  console.log(`Rebasing ${branchName} onto ${rebaseTarget}...`);
  const rebaseResult = isJj
    ? await spawnAndLogOutput(['jj', 'rebase', '-b', branchName, '-d', trunkBranch], {
        cwd: baseDir,
      })
    : await spawnAndLogOutput(['git', 'rebase', rebaseTarget], { cwd: baseDir });

  if (!isJj && rebaseResult.exitCode !== 0 && !(await isGitRebaseInProgress(baseDir))) {
    throw new Error(`Git rebase failed: ${rebaseResult.stderr || rebaseResult.stdout}`);
  }

  if (isJj && rebaseResult.exitCode !== 0) {
    throw new Error(`Jujutsu rebase failed: ${rebaseResult.stderr || rebaseResult.stdout}`);
  }

  const conflictsDetected = isJj
    ? await hasJujutsuConflicts(baseDir)
    : await isGitRebaseInProgress(baseDir);

  if (conflictsDetected) {
    console.log('Conflicts detected. Launching executor to resolve them...');
    await resolveRebaseConflicts({
      baseDir,
      plan: resolved.plan,
      planFilePath: currentPlanFile,
      isJj,
      executorName: options.executor ?? config.defaultExecutor ?? DEFAULT_EXECUTOR,
      model: options.model,
      terminalInput: options.terminalInput,
      configTerminalInput: config.terminalInput,
      config,
    });
  }

  const afterCommit = await getRebaseTargetRevision(baseDir, branchName, isJj);
  const changed =
    beforeRevision === null || afterCommit === null ? true : beforeRevision !== afterCommit;

  if (!changed) {
    console.log(`Branch ${branchName} is already up to date with ${trunkBranch}.`);
    return;
  }

  if (options.push === false) {
    console.log('Skipping push because --no-push was provided.');
    return;
  }

  console.log(`Pushing ${branchName}...`);
  await pushRebasedBranch(baseDir, branchName, isJj);
  console.log(`Successfully rebased ${branchName} onto ${trunkBranch}.`);
}

async function resolveRebasePlan(
  planFile: string | undefined,
  options: Pick<RebaseCommandOptions, 'current' | 'next'>,
  repoRoot: string,
  configPath?: string
): Promise<RebasePlanContext> {
  if (options.next || options.current) {
    const plan = await findNextPlanFromDb(repoRoot, repoRoot, {
      includePending: true,
      includeInProgress: options.current,
    });

    if (!plan) {
      if (options.current) {
        throw new Error(
          'No current plans found. No plans are in progress or ready to be implemented.'
        );
      }
      throw new Error('No ready plans found. All pending plans have incomplete dependencies.');
    }

    if (typeof plan.id !== 'number') {
      throw new Error('Resolved plan does not have a numeric ID.');
    }

    const resolved = await resolvePlanFromDbOrSyncFile(String(plan.id), repoRoot, repoRoot);
    return {
      plan: resolved.plan,
      planFile: resolved.planPath ?? '',
      repoRoot,
    };
  }

  if (!planFile) {
    throw new Error('Please provide a plan file or use --next/--current to find a plan.');
  }

  const planRepoRoot = await resolveRepoRootForPlanArg(planFile, repoRoot, configPath);
  const resolved = await resolvePlanFromDbOrSyncFile(planFile, planRepoRoot, planRepoRoot);
  return {
    plan: resolved.plan,
    planFile: resolved.planPath ?? '',
    repoRoot: planRepoRoot,
  };
}

async function hasJujutsuConflicts(baseDir: string): Promise<boolean> {
  const result = await spawnAndLogOutput(['jj', 'resolve', '--list'], {
    cwd: baseDir,
    quiet: true,
  });
  if (result.exitCode !== 0 && result.stdout.trim().length === 0) {
    throw new Error(`Failed to check jj conflicts: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim().length > 0;
}

async function getRebaseTargetRevision(
  baseDir: string,
  branchName: string,
  isJj: boolean
): Promise<string | null> {
  if (!isJj) {
    return getCurrentCommitHash(baseDir);
  }

  return getBookmarkCommitHash(baseDir, branchName);
}

async function getBookmarkCommitHash(baseDir: string, branchName: string): Promise<string | null> {
  const result = await spawnAndLogOutput(
    ['jj', 'log', '-r', branchName, '--no-graph', '-T', 'commit_id'],
    {
      cwd: baseDir,
      quiet: true,
    }
  );

  if (result.exitCode !== 0) {
    return null;
  }

  const commitId = result.stdout.trim();
  return commitId.length > 0 ? commitId : null;
}

async function isGitRebaseInProgress(baseDir: string): Promise<boolean> {
  const mergePath = await resolveGitPath(baseDir, 'rebase-merge');
  const applyPath = await resolveGitPath(baseDir, 'rebase-apply');
  return fs.existsSync(mergePath) || fs.existsSync(applyPath);
}

async function resolveGitPath(baseDir: string, subpath: string): Promise<string> {
  const result = await spawnAndLogOutput(['git', 'rev-parse', '--git-path', subpath], {
    cwd: baseDir,
    quiet: true,
  });

  if (result.exitCode !== 0) {
    return path.join(baseDir, '.git', subpath);
  }

  const resolved = result.stdout.trim();
  if (resolved.length === 0) {
    return path.join(baseDir, '.git', subpath);
  }

  return path.isAbsolute(resolved) ? resolved : path.join(baseDir, resolved);
}

async function resolveRebaseConflicts(options: {
  baseDir: string;
  plan: PlanSchema;
  planFilePath: string;
  isJj: boolean;
  executorName: string;
  model?: string;
  terminalInput?: boolean;
  configTerminalInput?: boolean;
  config: Awaited<ReturnType<typeof loadEffectiveConfig>>;
}): Promise<void> {
  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: options.baseDir,
    model: options.model,
    terminalInput:
      options.terminalInput !== false &&
      options.configTerminalInput !== false &&
      process.stdin.isTTY === true,
    disableInactivityTimeout: true,
  };

  const executor = buildExecutorAndLog(options.executorName, sharedExecutorOptions, options.config);
  let executorError: unknown;

  try {
    await executor.execute(options.isJj ? JUJUTSU_CONFLICT_PROMPT : GIT_CONFLICT_PROMPT, {
      planId: options.plan.id ? String(options.plan.id) : (options.plan.uuid ?? 'rebase'),
      planTitle: options.plan.title || `Rebase ${options.isJj ? 'jj' : 'git'} conflicts`,
      planFilePath: options.planFilePath,
      executionMode: 'bare',
    });
  } catch (error) {
    executorError = error;
  }

  if (!options.isJj && executorError && (await isGitRebaseInProgress(options.baseDir))) {
    await abortGitRebase(options.baseDir);
  }

  if (executorError) {
    throw executorError;
  }

  const conflictsRemain = options.isJj
    ? await hasJujutsuConflicts(options.baseDir)
    : await isGitRebaseInProgress(options.baseDir);

  if (conflictsRemain) {
    throw new Error(
      'Conflicts remain after the executor session finished. Please resolve them manually.'
    );
  }
}

async function abortGitRebase(baseDir: string): Promise<void> {
  const result = await spawnAndLogOutput(['git', 'rebase', '--abort'], {
    cwd: baseDir,
    quiet: true,
  });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to abort git rebase: ${result.stderr || result.stdout}`);
  }
}

async function pushRebasedBranch(
  baseDir: string,
  branchName: string,
  isJj: boolean
): Promise<void> {
  const result = isJj
    ? await spawnAndLogOutput(['jj', 'git', 'push', '--bookmark', branchName], { cwd: baseDir })
    : await spawnAndLogOutput(['git', 'push', '--force-with-lease', 'origin', branchName], {
        cwd: baseDir,
      });

  if (result.exitCode !== 0) {
    const vcsName = isJj ? 'Jujutsu' : 'Git';
    throw new Error(`${vcsName} push failed: ${result.stderr || result.stdout}`);
  }
}
