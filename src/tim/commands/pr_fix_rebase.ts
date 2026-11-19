import { isBranchBehindRemoteBase } from '../../common/git.js';
import { log, warn } from '../../logging.js';

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
    `Before you apply any ${fixes}, ask the user if they want to rebase this branch onto the latest \`${baseBranch}\` from origin and fix any conflicts. Do not rebase without the user's approval.`,
    '',
    'If the user approves the rebase:',
    '',
    `1. Rebase the branch onto the latest remote \`${baseBranch}\`. With jj, use a command such as \`jj rebase -b @ -d ${baseBranch}@origin\`. With git, use \`git rebase origin/${baseBranch}\`.`,
    '2. Resolve all conflicts. Look at both sides of each conflict and keep the intent of both changes. If the correct resolution is not clear, ask the user.',
    '3. Run type checking, linting, and tests appropriate to the changed files to make sure that the rebased branch works.',
    `4. Push the rebased branch and all stacked branches that the rebase changed. ${PUSH_AFTER_REBASE_RULE}`,
    `5. Continue with the ${fixes} on top of the rebased branch.`,
    '',
    staleNote,
    '',
    `If the user declines the rebase, continue with the ${fixes} on the current branch without rebasing.`,
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
