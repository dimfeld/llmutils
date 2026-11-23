import { isBranchBehindRemoteBase } from '../../common/git.js';
import type { Database } from 'bun:sqlite';

import { log, warn } from '../../logging.js';
import type { PrStatusDetail } from '../db/pr_status.js';
import { END_SESSION_TOOL_NAME } from '../executors/shared/end_session_tool.js';
import {
  findOpenStackForPr,
  getStackedBranchesAbovePr,
  type StackedBranch,
} from '../shepherd_bot/stack.js';

export interface PrFixRebaseStatus {
  /** Base branch that has commits the PR branch does not contain. */
  baseBranch: string;
}

const REBASE_FIX_KIND_TEXT = {
  review: {
    fixes: 'review fixes',
    staleNote:
      'Some review comments can become out of date after the rebase, for example because the base branch already fixed the issue. Check each comment against the rebased code before you apply a fix.',
  },
  ci: {
    fixes: 'CI fixes',
    staleNote:
      'Some CI failures can be fixed by the base branch changes, and the downloaded logs show the results from before the rebase. Check each diagnosis against the rebased code, and run the failing checks locally when possible, before you apply a fix.',
  },
} as const;

/** Short reminder that points to the "Pushing Rebased Branches" section. */
export const PUSH_AFTER_REBASE_RULE =
  'Push every branch that you rebase, including stacked branches, without asking for confirmation. See "Pushing Rebased Branches" below.';

/**
 * Instructions to push every branch that the agent rebases. Skills that help with stack
 * rebases can say not to push, so this section explicitly overrides them in PR fix
 * commands, where the user wants all rebased branches pushed.
 */
export function buildPushRebasedBranchesInstructions(): string[] {
  return [
    '## Pushing Rebased Branches',
    '',
    'Each time that you rebase one or more branches, push all of the branches that the rebase changed. Do not ask the user for confirmation before you push them. This includes:',
    '',
    '- The PR branch.',
    '- Each stacked branch above the PR branch, also when you did not change its code.',
    '- With jj, each bookmark that jj rebased automatically because you rewrote one of its ancestors.',
    '',
    'This rule overrides other instructions that tell you not to push, or to let the user push manually. For example, a skill that helps you rebase a stack can say that the user will push the branches. In this command, push the branches yourself. With git, use `git push --force-with-lease` because the rebase rewrote the branch history.',
    '',
  ];
}

/** Short reminder that points to the "Restacking Descendant Branches" section. */
export const RESTACK_AFTER_CHANGE_RULE =
  'After each change to this branch, restack all descendant branches onto it. See "Restacking Descendant Branches" below.';

/**
 * The branches of the open PRs that are stacked on top of the given PRs, from the cached PR
 * data in the database. Returns undefined when the lookup fails, because this information
 * is advisory and must not stop the fix run.
 */
export function findKnownStackedBranches(
  db: Database,
  prStatuses: readonly PrStatusDetail[]
): StackedBranch[] | undefined {
  try {
    const result: StackedBranch[] = [];
    const seen = new Set(prStatuses.map((detail) => detail.status.head_branch).filter(Boolean));
    for (const detail of prStatuses) {
      const stack = findOpenStackForPr(db, detail.status);
      for (const branch of getStackedBranchesAbovePr(stack, detail.status.pr_number)) {
        if (!seen.has(branch.headBranch)) {
          seen.add(branch.headBranch);
          result.push(branch);
        }
      }
    }
    return result;
  } catch (err) {
    warn(`Could not look up the stacked PRs: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Instructions to always restack the descendant branches after the agent changes the PR
 * branch. Descendants are easy to miss when they are based on an older version of the PR
 * branch, because then they are not descendants of the current commit.
 *
 * `knownStackedBranches` is the list of stacked PR branches from the PR database. When it
 * is undefined, the agent gets instructions to search for stacked branches itself.
 */
export function buildRestackDescendantsInstructions(
  knownStackedBranches?: readonly StackedBranch[]
): string[] {
  const lines = [
    '## Restacking Descendant Branches',
    '',
    'Each time that you change this branch (for example, you commit a fix, amend a commit, or rebase), restack all of the descendant branches onto the new version of this branch. Do this also when the change does not affect the code in the descendant branches. After you restack, run the checks on the descendant branches that the change can affect, and push the branches as described in "Pushing Rebased Branches".',
    '',
    'With jj, a change to a commit usually rebases its descendants automatically. Make sure that each descendant bookmark is now on top of the new version of this branch. With git, rebase each stacked branch onto the new version of its base branch, for example with `git rebase --onto <new base> <old base> <stacked branch>`.',
    '',
    'A stacked branch can be based on an older version of this branch, for example when this branch was rebased, amended, or updated from origin after the stacked branch was created. Then the stacked branch is not a descendant of the current commit, and `jj log -r "descendants(<PR bookmark>)"` or `git branch --contains <PR branch>` does not show it. If you find a stacked branch that is based on an older version of this branch, rebase it onto the current version of this branch, so that it contains only its own commits on top.',
    '',
  ];

  if (knownStackedBranches && knownStackedBranches.length > 0) {
    lines.push(
      "These open PR branches are stacked on this branch, from tim's PR data. Each branch comes after the branch that it is based on:",
      '',
      ...knownStackedBranches.map(
        (branch) => `- \`${branch.headBranch}\` (based on \`${branch.baseBranch}\`)`
      ),
      '',
      'Restack all of these branches, also when the local commands above do not show them as descendants. In that case, they are probably based on an older version of this branch, so find the local or remote version of each branch and rebase it. Also restack other local descendant branches that do not have a PR.',
      ''
    );
  } else if (knownStackedBranches) {
    lines.push(
      "tim's PR data shows no open PRs that are stacked on this branch. Restack only the local descendant branches that you find, if there are any. You do not need to search for stacked branches on older versions of this branch.",
      ''
    );
  } else {
    lines.push(
      'If you do not find descendant branches, they can still exist. Before you decide that no descendant branches exist, do these checks:',
      '',
      '- Use `gh pr list --base <PR branch>` to find open PRs that use this branch as their base.',
      '- With jj, look for bookmarks that are descendants of an earlier version of this branch. For example, use `jj evolog -r <PR bookmark>` to find the earlier commits, and `jj log -r "descendants(<earlier commit>) & bookmarks()"` to find bookmarks on top of them. Also look at the graph in `jj log -r "bookmarks() & ~::trunk()"`.',
      '- With git, look for local and remote branches whose history contains commits with the same changes or commit messages as this branch, for example with `git log --oneline <base>..<other branch>`.',
      ''
    );
  }

  return lines;
}

export function buildRebaseInstructions(
  { baseBranch }: PrFixRebaseStatus,
  fixKind: keyof typeof REBASE_FIX_KIND_TEXT = 'review'
): string[] {
  const { fixes, staleNote } = REBASE_FIX_KIND_TEXT[fixKind];
  return [
    '## Base Branch Updates',
    '',
    `The base branch \`${baseBranch}\` has new commits that this branch does not contain. For example, the base branch may have received its own fixes after this branch was created.`,
    '',
    `Before you apply any ${fixes}, rebase this branch onto the latest \`${baseBranch}\` from origin and fix any conflicts. You do not need to ask the user before you rebase.`,
    '',
    `1. Rebase the branch onto the latest remote \`${baseBranch}\`. With jj, use a command such as \`jj rebase -b @ -d ${baseBranch}@origin\`. With git, use \`git rebase origin/${baseBranch}\`.`,
    '2. Resolve all conflicts. Look at both sides of each conflict and keep the intent of both changes. If the correct resolution is not clear, ask the user.',
    '3. Run type checking, linting, and tests appropriate to the changed files to make sure that the rebased branch works.',
    `4. Push the rebased branch and all stacked branches that the rebase changed. ${PUSH_AFTER_REBASE_RULE}`,
    `5. Continue with the ${fixes} on top of the rebased branch.`,
    '',
    staleNote,
    '',
  ];
}

/**
 * Instructions for the `EndTimSession` tool, which lets the agent end its interactive session
 * after its turn. `conditions` lists when the agent must end the session without the user.
 */
export function buildEndSessionInstructions(conditions: string[]): string[] {
  return [
    '## Ending the Session',
    '',
    `The \`${END_SESSION_TOOL_NAME}\` tool ends this session after your turn, so that the user does not have to end it. Before you end each turn, examine each of these conditions. If all of them are true, you must call \`${END_SESSION_TOOL_NAME}\`. This is not optional, and it is not a choice that you make. If one or more conditions are false, do not call it:`,
    '',
    ...conditions.map((condition) => `- ${condition}`),
    '- All of your work is committed and pushed, and all replies that you must post are posted.',
    '- You have no open question for the user, and you do not need an answer from the user.',
    '',
    `When you call \`${END_SESSION_TOOL_NAME}\`, give a short reason. Write your final message (for example, the report) in the same turn, because the user cannot reply after the session ends. If you are not sure that the user can skip a review of your work, do not call the tool; stop and wait for the user.`,
    '',
  ];
}

/**
 * Instructions for a jj bookmark that has more than one target, for example after the
 * local and remote versions of a branch were changed separately. Agents often compare
 * the two targets with a whole-tree diff, which includes the differences between their
 * bases and makes the two versions look much more different than they are.
 */
export function buildJjBookmarkConflictInstructions(): string[] {
  return [
    '## jj Bookmark Conflicts',
    '',
    'If the repository uses jj and a bookmark has more than one target (a conflicted bookmark), do these steps before you change or push the bookmark:',
    '',
    "1. Find the base of each version's branch-specific work. Use the ancestry (`jj log`) and the evolution history (`jj evolog`) to find out if one version was rebased or rewritten from the other, or if the two versions were developed separately. Use the commit before the first commit of the branch work as the base. When the work has more than one commit, do not use the immediate parent of the target.",
    '2. Do not use a whole-tree comparison between the two targets as the first measure of their differences. `jj diff --from TARGET_A --to TARGET_B` includes the differences that come from their different bases. The common ancestor of the two targets can also be too old to isolate the branch work.',
    '3. Compare the complete branch-specific patch of each version against its own base: `jj diff --from BASE_A --to TARGET_A` and `jj diff --from BASE_B --to TARGET_B`. Compare the lists of changed files and the patches first. Then compare the target file contents for those files only. For each difference in a file that both versions changed, find out if it came from the branch work or from the base history.',
    '4. Put the differences into three categories: equivalent changes, changes that come from different bases, and changes that occur in only one version. Tell the user the meaningful differences before you propose a resolution. Large whole-tree statistics alone are not evidence of competing work, removed features, or lost tests.',
    '5. Combine the unique fixes, documentation, and tests from the two versions. Where the changes overlap, keep one shared implementation, and keep all permission checks. Validate the result before you set the bookmark to it and push. Ask the user only when a specific behavior conflict is not clear.',
    '',
  ];
}

/**
 * Check whether the PR branch in `workspacePath` is behind its remote base branch.
 * Returns undefined when no rebase is needed or the check cannot be done, because
 * this check is advisory and must not stop the fix run.
 */
export async function detectPrFixRebaseStatus(
  workspacePath: string,
  baseBranch: string | null | undefined
): Promise<PrFixRebaseStatus | undefined> {
  if (!baseBranch) {
    return undefined;
  }

  try {
    const behind = await isBranchBehindRemoteBase(workspacePath, baseBranch);
    if (behind) {
      log(`Branch is behind base branch "${baseBranch}"; the agent will offer to rebase first.`);
      return { baseBranch };
    }
  } catch (err) {
    warn(
      `Could not check whether the branch is behind "${baseBranch}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return undefined;
}
