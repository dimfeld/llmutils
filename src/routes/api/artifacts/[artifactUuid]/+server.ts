import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { getServerContext } from '$lib/server/init.js';
import { quoteHeaderValue } from '$lib/server/http_headers.js';
import { getArtifactByUuid } from '$tim/db/artifact.js';
import { artifactFileExists } from '$tim/artifacts/storage.js';
import { enqueueMissingArtifactDownloads } from '$tim/sync/artifact_scheduling.js';

const INLINE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

const VIEW_INLINE_MIME_TYPES = new Set([
  ...INLINE_MIME_TYPES,
  'application/json',
  'text/markdown',
  'text/plain',
]);

const VIEW_TEXT_EXTENSIONS = new Set([
  '.c',
  '.css',
  '.go',
  '.h',
  '.html',
  '.js',
  '.jsonl',
  '.jsx',
  '.log',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.sh',
  '.svelte',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

function isViewableInline(filename: string, mimeType: string, viewMode: boolean): boolean {
  if (INLINE_MIME_TYPES.has(mimeType)) return true;
  if (!viewMode) return false;
  if (VIEW_INLINE_MIME_TYPES.has(mimeType)) return true;
  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) return true;
  if (mimeType.startsWith('text/')) return true;
  return VIEW_TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function responseContentType(filename: string, mimeType: string, viewMode: boolean): string {
  if (viewMode && VIEW_TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
    return 'text/plain; charset=utf-8';
  }
  if (viewMode && mimeType.startsWith('text/')) {
    return `${mimeType}; charset=utf-8`;
  }
  return mimeType;
}

function contentDisposition(filename: string, mimeType: string, viewMode: boolean): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_');
  const disposition = isViewableInline(filename, mimeType, viewMode) ? 'inline' : 'attachment';
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

  const viewMode = url.searchParams.get('view') === '1';
  const stream = Readable.toWeb(
    fs.createReadStream(artifact.storagePath)
  ) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: {
      'Content-Type': responseContentType(artifact.filename, artifact.mimeType, viewMode),
      'Content-Length': String(artifact.size),
      'Content-Disposition': contentDisposition(artifact.filename, artifact.mimeType, viewMode),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-cache',
      ETag: etag,
    },
  });
};
