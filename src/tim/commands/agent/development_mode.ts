import type { Executor } from '../../executors/types.js';

export interface PlanDevelopmentModeOptions {
  executor: Executor;
  planId: string;
  planTitle: string;
  planFilePath: string;
  branch: string;
  useJj: boolean;
}

export function buildSquashRebasePrompt(options: PlanDevelopmentModeOptions): string {
  const vcs = options.useJj ? 'Jujutsu (jj)' : 'Git';
  const mainRef = options.useJj ? 'main@origin' : 'origin/main';
  return `# Complete plan branch

The plan is complete and its final changes have been committed. Read the plan at \`${options.planFilePath}\` when you need task context. Work in the current workspace using ${vcs}. The plan branch is \`${options.branch}\`; the target is \`${mainRef}\`.

1. Inspect the branch and working copy. Keep any changes that belong to the plan. Do not rewrite unrelated branches.
2. Fetch the latest \`main\` state from \`origin\` before rewriting the plan branch (fetch \`origin/main\` with Git or run \`jj git fetch\` with Jujutsu). Squash the plan's commits into one commit, preserving all plan changes and a descriptive message. Rebase that commit onto the updated \`main\`.
3. If the rebase has conflicts, inspect both sides, resolve each conflict according to the plan and current code, continue the rebase, and run relevant checks for the affected code. Do not discard either side without examining it.
4. Check the remote \`main\` tip again immediately before pushing. If it has moved since the rebase, fetch it, rebase the squashed commit again, resolve conflicts, and repeat the checks.
5. Push the rebased commit directly to \`origin/main\` as a fast-forward update. Never force-update \`main\`. If the push is rejected because \`main\` moved, fetch, rebase, resolve conflicts, run the checks again, and retry. Continue until the push succeeds.
6. After the push succeeds, remove the plan branch from the local workspace and \`origin\` if it exists. Do not create a pull request or leave the plan branch behind.

Use \`jj\` for all version-control operations in a Jujutsu workspace. If a conflict cannot be resolved from the available evidence, report a line starting with \`FAILED:\` and explain what decision is needed. Report the final \`main\` revision when finished.`;
}

export async function runPlanDevelopmentMode(options: PlanDevelopmentModeOptions): Promise<void> {
  const output = await options.executor.execute(buildSquashRebasePrompt(options), {
    planId: options.planId,
    planTitle: options.planTitle,
    planFilePath: options.planFilePath,
    executionMode: 'bare',
    captureOutput: 'result',
  });

  if (!output || output.success === false) {
    throw new Error(output?.failureDetails?.problems ?? 'Plan branch finalization failed.');
  }
}
