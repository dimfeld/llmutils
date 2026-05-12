import * as fs from 'node:fs';
import { Readable } from 'node:stream';

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { getServerContext } from '$lib/server/init.js';
import { getArtifactByUuid } from '$tim/db/artifact.js';
import { artifactFileExists } from '$tim/artifacts/storage.js';
import { enqueueMissingArtifactDownloads } from '$tim/sync/artifact_scheduling.js';

function quoteHeaderValue(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

const INLINE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

function contentDisposition(filename: string, mimeType: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_');
  const disposition = INLINE_MIME_TYPES.has(mimeType) ? 'inline' : 'attachment';
  return `${disposition}; filename=${quoteHeaderValue(fallback)}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const GET: RequestHandler = async ({ params, request, url }) => {
  const { db, config } = await getServerContext();
  const artifact = getArtifactByUuid(db, params.artifactUuid);
  if (!artifact) {
    error(404, 'Artifact not found');
  }

  if (artifact.deletedAt && url.searchParams.get('includeDeleted') !== '1') {
    error(410, 'Artifact has been deleted');
  }

  const etag = quoteHeaderValue(artifact.sha256);
  if (!(await artifactFileExists(artifact.storagePath))) {
    const sync = config.sync;
    if (sync?.mainUrl && sync.nodeId && sync.disabled !== true && sync.offline !== true) {
      void enqueueMissingArtifactDownloads({
        db,
        serverUrl: sync.mainUrl,
        nodeId: sync.nodeId,
      }).catch((caught) => {
        console.warn(
          `Failed to enqueue artifact download after file-missing response for ${artifact.uuid}:`,
          caught
        );
      });
    }
    return json({ error: 'file_missing' }, { status: 409 });
  }

  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
      },
    });
  }

  const stream = Readable.toWeb(
    fs.createReadStream(artifact.storagePath)
  ) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: {
      'Content-Type': artifact.mimeType,
      'Content-Length': String(artifact.size),
      'Content-Disposition': contentDisposition(artifact.filename, artifact.mimeType),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-cache',
      ETag: etag,
    },
  });
};
