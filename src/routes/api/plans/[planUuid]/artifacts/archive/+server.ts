import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { getServerContext } from '$lib/server/init.js';
import { quoteHeaderValue } from '$lib/server/http_headers.js';
import { createStoredZip, type ZipEntryInput } from '$tim/artifacts/zip.js';
import { listArtifactsForPlan } from '$tim/db/artifact.js';
import { getPlanByUuid } from '$tim/db/plan.js';
import { enqueueMissingArtifactDownloads } from '$tim/sync/artifact_scheduling.js';

function archiveFilename(planId: number | null | undefined): string {
  return `plan-${planId ?? 'artifacts'}-artifacts.zip`;
}

function zipSafeFilename(filename: string, used: Set<string>): string {
  // Preserve any relative subdirectory so grouped artifacts stay together in
  // the archive, while stripping traversal/absolute components that could
  // escape the extraction directory (zip slip).
  const segments = (filename.trim() || 'artifact')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  const dir = segments.slice(0, -1).join('/');
  const last = segments[segments.length - 1] ?? 'artifact';
  const parsed = path.parse(last);
  const base = parsed.name || 'artifact';
  const ext = parsed.ext;
  const prefix = dir ? `${dir}/` : '';
  let candidate = `${prefix}${base}${ext}`;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${prefix}${base} (${index})${ext}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

export const GET: RequestHandler = async ({ params }) => {
  const { db, config } = await getServerContext();
  const plan = getPlanByUuid(db, params.planUuid);
  if (!plan) {
    error(404, 'Plan not found');
  }

  const artifacts = listArtifactsForPlan(db, params.planUuid);
  const missingArtifacts: Array<{ uuid: string; filename: string }> = [];
  const usedFilenames = new Set<string>();
  const entries: ZipEntryInput[] = [];

  for (const artifact of artifacts) {
    let data: Buffer;
    try {
      data = await fsp.readFile(artifact.storagePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        missingArtifacts.push({ uuid: artifact.uuid, filename: artifact.filename });
        continue;
      }
      throw err;
    }

    entries.push({
      filename: zipSafeFilename(artifact.filename, usedFilenames),
      data,
      modifiedAt: artifact.updatedAt,
    });
  }

  if (missingArtifacts.length > 0) {
    const sync = config.sync;
    if (sync?.mainUrl && sync.nodeId && sync.disabled !== true && sync.offline !== true) {
      void enqueueMissingArtifactDownloads({
        db,
        serverUrl: sync.mainUrl,
        nodeId: sync.nodeId,
      }).catch((caught) => {
        console.warn(
          `Failed to enqueue artifact downloads after archive file-missing response for plan ${params.planUuid}:`,
          caught
        );
      });
    }

    return json({ error: 'file_missing', artifacts: missingArtifacts }, { status: 409 });
  }

  const zip = createStoredZip(entries);
  const filename = archiveFilename(plan.plan_id);
  const body = new Uint8Array(zip.length);
  body.set(zip);

  return new Response(body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(zip.length),
      'Content-Disposition': `attachment; filename=${quoteHeaderValue(filename)}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-cache',
    },
  });
};
