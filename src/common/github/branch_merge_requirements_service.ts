import type { Database } from 'bun:sqlite';
import { fetchBranchMergeRequirements } from './branch_merge_requirements.js';
import {
  getBranchMergeRequirements,
  upsertBranchMergeRequirements,
} from '../../tim/db/branch_merge_requirements.js';

function getNowIsoString(): string {
  return new Date().toISOString();
}

function githubFetchOptions(options: { authToken?: string }): { authToken?: string } | undefined {
  return options.authToken ? options : undefined;
}

export async function refreshBranchMergeRequirements(
  db: Database,
  owner: string,
  repo: string,
  branchName: string,
  options: { authToken?: string } = {}
) {
  const fetchOptions = githubFetchOptions(options);
  const snapshot = await fetchBranchMergeRequirements(
    owner,
    repo,
    branchName,
    ...(fetchOptions ? [fetchOptions] : [])
  );
  return upsertBranchMergeRequirements(db, {
    owner,
    repo,
    branchName,
    lastFetchedAt: getNowIsoString(),
    requirements: snapshot.requirements,
  });
}

export async function ensureBranchMergeRequirementsFresh(
  db: Database,
  owner: string,
  repo: string,
  branchName: string,
  maxAgeMs: number,
  options: { authToken?: string } = {}
) {
  const existing = getBranchMergeRequirements(db, owner, repo, branchName);
  if (!existing) {
    return refreshBranchMergeRequirements(db, owner, repo, branchName, options);
  }

  const lastFetchedAtMs = Date.parse(existing.branch.last_fetched_at);
  if (!Number.isFinite(lastFetchedAtMs)) {
    return refreshBranchMergeRequirements(db, owner, repo, branchName, options);
  }

  if (Date.now() - lastFetchedAtMs <= maxAgeMs) {
    return existing;
  }

  return refreshBranchMergeRequirements(db, owner, repo, branchName, options);
}
