import type { Database } from 'bun:sqlite';
import { fetchBranchMergeRequirements } from './branch_merge_requirements.js';
import {
  getBranchMergeRequirements,
  upsertBranchMergeRequirements,
} from '../../tim/db/branch_merge_requirements.js';

function getNowIsoString(): string {
  return new Date().toISOString();
}

export async function refreshBranchMergeRequirements(
  db: Database,
  owner: string,
  repo: string,
  branchName: string
) {
  const snapshot = await fetchBranchMergeRequirements(owner, repo, branchName);
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
  maxAgeMs: number
) {
  const existing = getBranchMergeRequirements(db, owner, repo, branchName);
  if (!existing) {
    return refreshBranchMergeRequirements(db, owner, repo, branchName);
  }

  const lastFetchedAtMs = Date.parse(existing.branch.last_fetched_at);
  if (!Number.isFinite(lastFetchedAtMs)) {
    return refreshBranchMergeRequirements(db, owner, repo, branchName);
  }

  if (Date.now() - lastFetchedAtMs <= maxAgeMs) {
    return existing;
  }

  return refreshBranchMergeRequirements(db, owner, repo, branchName);
}
