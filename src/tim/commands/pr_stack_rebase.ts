import { $ } from 'bun';

import type { StackedBranch } from '../shepherd_bot/stack.js';

export interface CleanStackRebaseTarget {
  headBranch: string;
  baseBranch: string;
}

export type CleanStackRebaseResult =
  | { status: 'pushed'; branches: string[] }
  | { status: 'needs_agent'; reason: string };

/**
 * Rebase the PR branch and the branches stacked on top of it onto the latest remote base
 * branch, without an agent. When the rebase is clean, push all the branches. When the rebase
 * has conflicts, or a stacked branch does not end up on top of its rebased base branch,
 * restore the original state and return `needs_agent`.
 *
 * The base branch and the stacked branches must already be fetched from origin. In jj, the
 * stacked branches must also have local bookmarks. Throws when the push fails.
 */
export async function tryCleanStackRebase(
  workspacePath: string,
  target: CleanStackRebaseTarget,
  stackedBranches: StackedBranch[],
  usingJj: boolean
): Promise<CleanStackRebaseResult> {
  return usingJj
    ? tryCleanStackRebaseJj(workspacePath, target, stackedBranches)
    : tryCleanStackRebaseGit(workspacePath, target, stackedBranches);
}

async function tryCleanStackRebaseJj(
  workspacePath: string,
  target: CleanStackRebaseTarget,
  stackedBranches: StackedBranch[]
): Promise<CleanStackRebaseResult> {
  const allBranches = [target.headBranch, ...stackedBranches.map((branch) => branch.headBranch)];
  const opId = (
    await $`jj op log --no-graph --limit 1 -T ${'id'}`.cwd(workspacePath).quiet().text()
  ).trim();

  const restore = async (reason: string): Promise<CleanStackRebaseResult> => {
    await $`jj op restore ${opId}`.cwd(workspacePath).quiet();
    return { status: 'needs_agent', reason };
  };

  // A rebase with -b also moves the descendants of the branch, which include the stacked
  // bookmarks. Commits of an old version of the base branch become empty and are abandoned.
  const rebase =
    await $`jj rebase -b ${target.headBranch} -d ${`${target.baseBranch}@origin`} --skip-emptied`
      .cwd(workspacePath)
      .quiet()
      .nothrow();
  if (rebase.exitCode !== 0) {
    return restore(`jj rebase failed: ${rebase.stderr.toString().trim()}`);
  }

  const conflictRevset = `conflicts() & (${target.baseBranch}@origin..(${allBranches.map(quoteJjSymbol).join(' | ')}))`;
  const conflicts = (
    await $`jj log -r ${conflictRevset} --no-graph -T ${'commit_id ++ "\\n"'}`
      .cwd(workspacePath)
      .quiet()
      .text()
  ).trim();
  if (conflicts.length > 0) {
    return restore('The rebase has conflicts');
  }

  for (const branch of stackedBranches) {
    const revset = `${quoteJjSymbol(branch.baseBranch)} & ::${quoteJjSymbol(branch.headBranch)}`;
    const onTop = (
      await $`jj log -r ${revset} --no-graph -T ${'commit_id'}`.cwd(workspacePath).quiet().text()
    ).trim();
    if (onTop.length === 0) {
      return restore(`${branch.headBranch} is not on top of ${branch.baseBranch}`);
    }
  }

  const bookmarkArgs = allBranches.flatMap((branch) => ['--bookmark', branch]);
  const push = await $`jj git push ${bookmarkArgs}`.cwd(workspacePath).quiet().nothrow();
  if (push.exitCode !== 0) {
    await $`jj op restore ${opId}`.cwd(workspacePath).quiet().nothrow();
    throw new Error(`jj git push failed: ${push.stderr.toString().trim()}`);
  }

  return { status: 'pushed', branches: allBranches };
}

async function tryCleanStackRebaseGit(
  workspacePath: string,
  target: CleanStackRebaseTarget,
  stackedBranches: StackedBranch[]
): Promise<CleanStackRebaseResult> {
  const allBranches = [target.headBranch, ...stackedBranches.map((branch) => branch.headBranch)];
  const originalHead = (
    await $`git rev-parse ${`refs/heads/${target.headBranch}`}`.cwd(workspacePath).quiet().text()
  ).trim();

  const restore = async (reason: string): Promise<CleanStackRebaseResult> => {
    await $`git rebase --abort`.cwd(workspacePath).quiet().nothrow();
    await $`git checkout -f -B ${target.headBranch} ${originalHead}`.cwd(workspacePath).quiet();
    for (const branch of stackedBranches) {
      await $`git branch -f ${branch.headBranch} ${`origin/${branch.headBranch}`}`
        .cwd(workspacePath)
        .quiet()
        .nothrow();
    }
    return { status: 'needs_agent', reason };
  };

  await $`git checkout ${target.headBranch}`.cwd(workspacePath).quiet();
  const rebase = await $`git rebase ${`origin/${target.baseBranch}`}`
    .cwd(workspacePath)
    .quiet()
    .nothrow();
  if (rebase.exitCode !== 0) {
    return restore(`Rebasing ${target.headBranch} failed`);
  }

  // Move each stacked branch from the old version of its base branch on origin to the
  // rebased version. Do this before the push, while origin still has the old versions.
  for (const branch of stackedBranches) {
    const checkout = await $`git checkout -B ${branch.headBranch} ${`origin/${branch.headBranch}`}`
      .cwd(workspacePath)
      .quiet()
      .nothrow();
    if (checkout.exitCode !== 0) {
      return restore(`Could not check out ${branch.headBranch}`);
    }
    const stackedRebase =
      await $`git rebase --onto ${branch.baseBranch} ${`origin/${branch.baseBranch}`} ${branch.headBranch}`
        .cwd(workspacePath)
        .quiet()
        .nothrow();
    if (stackedRebase.exitCode !== 0) {
      return restore(`Rebasing ${branch.headBranch} failed`);
    }
  }

  await $`git checkout ${target.headBranch}`.cwd(workspacePath).quiet();
  const push = await $`git push --atomic --force-with-lease origin ${allBranches}`
    .cwd(workspacePath)
    .quiet()
    .nothrow();
  if (push.exitCode !== 0) {
    await restore('The push failed');
    throw new Error(`git push failed: ${push.stderr.toString().trim()}`);
  }

  return { status: 'pushed', branches: allBranches };
}

/** Quote a bookmark name for a jj revset, so that names with `/` or `-` parse as symbols. */
function quoteJjSymbol(name: string): string {
  return JSON.stringify(name);
}
