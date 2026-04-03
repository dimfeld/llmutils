import type { Database } from 'bun:sqlite';

import type { IngestResult } from '$common/github/webhook_ingest.js';
import { constructGitHubRepositoryId } from '$common/github/pull_requests.js';

import type { SessionManager } from './session_manager.js';

function parseCanonicalPrUrl(prUrl: string): { owner: string; repo: string } | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(prUrl);
  } catch {
    return null;
  }

  if (parsedUrl.hostname !== 'github.com') {
    return null;
  }

  const match = /^\/([^/]+)\/([^/]+)\/pull\/\d+$/.exec(parsedUrl.pathname);
  if (!match) {
    return null;
  }

  return {
    owner: match[1]!,
    repo: match[2]!,
  };
}

export function getProjectIdsForPrUrls(db: Database, prUrls: string[]): number[] {
  const repositoryIds = new Set<string>();
  for (const prUrl of prUrls) {
    const ownerRepo = parseCanonicalPrUrl(prUrl);
    if (!ownerRepo) {
      continue;
    }

    repositoryIds.add(constructGitHubRepositoryId(ownerRepo.owner, ownerRepo.repo));
  }

  if (repositoryIds.size === 0) {
    return [];
  }

  const placeholders = Array.from({ length: repositoryIds.size }, () => '?').join(', ');
  return db
    .prepare(`SELECT id FROM project WHERE repository_id IN (${placeholders}) ORDER BY id`)
    .all(...repositoryIds)
    .map((row) => (row as { id: number }).id);
}

export function emitPrUpdatesForIngestResult(
  db: Database,
  ingestResult: IngestResult,
  sessionManager: Pick<SessionManager, 'emitPrUpdate' | 'hasPrUpdateListeners'>
): void {
  if (ingestResult.prsUpdated.length === 0 || !sessionManager.hasPrUpdateListeners()) {
    return;
  }

  sessionManager.emitPrUpdate(
    ingestResult.prsUpdated,
    getProjectIdsForPrUrls(db, ingestResult.prsUpdated)
  );
}
