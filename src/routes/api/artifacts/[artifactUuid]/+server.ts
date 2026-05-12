import * as fs from 'node:fs';
import { Readable } from 'node:stream';

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { getServerContext } from '$lib/server/init.js';
import { getArtifactByUuid } from '$tim/db/artifact.js';
import { artifactFileExists } from '$tim/artifacts/storage.js';

function quoteHeaderValue(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_');
  return `inline; filename=${quoteHeaderValue(fallback)}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const GET: RequestHandler = async ({ params, request, url }) => {
  const { db } = await getServerContext();
  const artifact = getArtifactByUuid(db, params.artifactUuid);
  if (!artifact) {
    error(404, 'Artifact not found');
  }

  if (artifact.deletedAt && url.searchParams.get('includeDeleted') !== '1') {
    error(410, 'Artifact has been deleted');
  }

  const etag = quoteHeaderValue(artifact.sha256);
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
      },
    });
  }

  if (!(await artifactFileExists(artifact.storagePath))) {
    return json({ error: 'file_missing' }, { status: 409 });
  }

  const stream = Readable.toWeb(
    fs.createReadStream(artifact.storagePath)
  ) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: {
      'Content-Type': artifact.mimeType,
      'Content-Length': String(artifact.size),
      'Content-Disposition': contentDisposition(artifact.filename),
      ETag: etag,
    },
  });
};
