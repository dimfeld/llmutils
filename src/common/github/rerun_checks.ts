import type { Octokit } from 'octokit';

import { parseActionsDetailsUrl } from './workflow_logs.js';

export interface RerunCheckInput {
  name: string;
  detailsUrl: string | null;
}

export interface RerunChecksResult {
  /** Checks whose workflow run was started again. */
  rerun: string[];
  /** Checks whose workflow run has not finished yet. GitHub can rerun a run only after it ends. */
  stillRunning: string[];
  /** Checks that are not GitHub Actions jobs of this repository, such as third-party apps. */
  unsupported: string[];
  /** Workflow runs that GitHub refused to rerun. */
  errors: Array<{ checks: string[]; message: string }>;
}

/**
 * Rerun the GitHub Actions workflow runs of the given checks. Use this for checks that were
 * cancelled. Each workflow run is rerun once with `rerun-failed-jobs`, which starts its failed
 * and cancelled jobs again. One call for each run is necessary, because a rerun of one job
 * starts a new attempt, and then GitHub refuses reruns of other jobs from the old attempt.
 */
export async function rerunActionsChecks(
  octokit: Octokit,
  owner: string,
  repo: string,
  checks: readonly RerunCheckInput[]
): Promise<RerunChecksResult> {
  const result: RerunChecksResult = { rerun: [], stillRunning: [], unsupported: [], errors: [] };
  const checksByRun = new Map<number, string[]>();

  for (const check of checks) {
    const parsed = check.detailsUrl ? parseActionsDetailsUrl(check.detailsUrl) : null;
    if (
      !parsed ||
      parsed.owner.toLowerCase() !== owner.toLowerCase() ||
      parsed.repo.toLowerCase() !== repo.toLowerCase()
    ) {
      result.unsupported.push(check.name);
      continue;
    }
    const names = checksByRun.get(parsed.runId);
    if (names) {
      names.push(check.name);
    } else {
      checksByRun.set(parsed.runId, [check.name]);
    }
  }

  for (const [runId, names] of checksByRun) {
    try {
      const { data: run } = await octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });
      if (run.status !== 'completed') {
        result.stillRunning.push(...names);
        continue;
      }
      await octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: runId });
      result.rerun.push(...names);
    } catch (err) {
      result.errors.push({
        checks: names,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/** A one-line description of a rerun result, for the UI and the bot action log. */
export function describeRerunChecksResult(result: RerunChecksResult): string {
  const parts: string[] = [];
  if (result.rerun.length > 0) {
    parts.push(`Started again: ${result.rerun.join(', ')}.`);
  }
  if (result.stillRunning.length > 0) {
    parts.push(
      `Their workflow run has not finished, so they cannot run again yet: ${result.stillRunning.join(', ')}.`
    );
  }
  if (result.unsupported.length > 0) {
    parts.push(`Not GitHub Actions jobs, rerun them on GitHub: ${result.unsupported.join(', ')}.`);
  }
  for (const error of result.errors) {
    parts.push(`GitHub refused to rerun ${error.checks.join(', ')}: ${error.message}`);
  }
  return parts.length > 0 ? parts.join(' ') : 'No checks to rerun.';
}
