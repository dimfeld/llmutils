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
    `4. Continue with the ${fixes} on top of the rebased branch. When you push, a force push is necessary because the rebase rewrote the branch history. With git, use \`git push --force-with-lease\`. With jj, \`jj git push\` handles this automatically.`,
    '',
    staleNote,
    '',
    `If the user declines the rebase, continue with the ${fixes} on the current branch without rebasing.`,
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
