import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { MAX_ARTIFACT_BYTES } from '../artifacts/constants.js';
import { artifactFileExists, resolveArtifactPath } from '../artifacts/storage.js';
import type { PlanArtifact } from '../artifacts/types.js';
import {
  getArtifactTransfer,
  markTransferFailed,
  markTransferInProgress,
  markTransferSucceeded,
} from '../db/artifact_transfer.js';
import { authHeaders, isConnectionError, syncUrl, toError } from './http_utils.js';

export interface ArtifactTransferOptions {
  db: Database;
  serverUrl: string;
  token: string;
  nodeId: string;
  syncServerNodeId: string;
  artifact: PlanArtifact;
}

export class ArtifactNotYetAvailableError extends Error {
  constructor(message = 'Artifact bytes are not available on the sync server yet') {
    super(message);
    this.name = 'ArtifactNotYetAvailableError';
  }
}

class ArtifactTransferVerificationError extends Error {}

class ArtifactTransferBodyTooLargeError extends Error {}

export async function uploadArtifact(options: ArtifactTransferOptions): Promise<void> {
  const existing = getArtifactTransfer(
    options.db,
    options.artifact.uuid,
    options.syncServerNodeId,
    'upload'
  );
  if (existing?.status === 'succeeded') {
    return;
  }

  markTransferInProgress(options.db, options.artifact.uuid, options.syncServerNodeId, 'upload');

  try {
    const storagePath = artifactStoragePath(options.artifact);
    if (!(await artifactFileExists(storagePath))) {
      throw new Error(`Artifact file is missing: ${storagePath}`);
    }
    const body = Bun.file(storagePath).stream();
    const response = await fetch(artifactUrl(options.serverUrl, options.artifact.uuid), {
      method: 'PUT',
      headers: authHeaders(options.token, options.nodeId, {
        'content-type': 'application/octet-stream',
        'content-length': String(options.artifact.size),
        'x-artifact-sha256': options.artifact.sha256,
      }),
      body,
      duplex: 'half',
    });

    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    const payload = (await response.json()) as { ok?: boolean; size?: number; sha256?: string };
    if (
      payload.ok !== true ||
      payload.size !== options.artifact.size ||
      payload.sha256 !== options.artifact.sha256
    ) {
      throw new ArtifactTransferVerificationError('Sync server acknowledged mismatched artifact');
    }

    markTransferSucceeded(options.db, options.artifact.uuid, options.syncServerNodeId, 'upload');
  } catch (err) {
    const error = toTransferError(err);
    markTransferFailed(
      options.db,
      options.artifact.uuid,
      options.syncServerNodeId,
      'upload',
      error
    );
    throw error;
  }
}

export async function downloadArtifact(options: ArtifactTransferOptions): Promise<void> {
  const existing = getArtifactTransfer(
    options.db,
    options.artifact.uuid,
    options.syncServerNodeId,
    'download'
  );

  const storagePath = artifactStoragePath(options.artifact);
  const tempPath = `${storagePath}.tmp-${randomUUID()}`;
  try {
    if (existing?.status === 'succeeded') {
      try {
        if (await localFileMatches(storagePath, options.artifact.size, options.artifact.sha256)) {
          return;
        }
      } catch (err) {
        markTransferInProgress(
          options.db,
          options.artifact.uuid,
          options.syncServerNodeId,
          'download'
        );
        throw err;
      }
    }

    markTransferInProgress(options.db, options.artifact.uuid, options.syncServerNodeId, 'download');

    if (await localFileMatches(storagePath, options.artifact.size, options.artifact.sha256)) {
      markTransferSucceeded(
        options.db,
        options.artifact.uuid,
        options.syncServerNodeId,
        'download'
      );
      return;
    }

    await fsp.mkdir(path.dirname(storagePath), { recursive: true });
    const response = await fetch(artifactUrl(options.serverUrl, options.artifact.uuid), {
      headers: authHeaders(options.token, options.nodeId),
    });
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    if (!response.body) {
      throw new Error('Artifact download response did not include a body');
    }

    const result = await writeResponseBodyWithHash(response.body, tempPath);
    if (result.size !== options.artifact.size) {
      throw new ArtifactTransferVerificationError(
        `Artifact size mismatch: expected ${options.artifact.size}, received ${result.size}`
      );
    }
    if (result.sha256 !== options.artifact.sha256) {
      throw new ArtifactTransferVerificationError(
        `Artifact sha256 mismatch: expected ${options.artifact.sha256}, received ${result.sha256}`
      );
    }

    await fsp.rename(tempPath, storagePath);
    markTransferSucceeded(options.db, options.artifact.uuid, options.syncServerNodeId, 'download');
  } catch (err) {
    await removeTempFile(tempPath);
    const error = toTransferError(err);
    markTransferFailed(
      options.db,
      options.artifact.uuid,
      options.syncServerNodeId,
      'download',
      error
    );
    throw error;
  }
}

export function artifactUrl(serverUrl: string, artifactUuid: string): URL {
  return syncUrl(serverUrl, `internal/sync/artifacts/${artifactUuid}`);
}

function artifactStoragePath(artifact: PlanArtifact): string {
  return resolveArtifactPath(
    artifact.projectUuid,
    artifact.planUuid,
    artifact.uuid,
    path.extname(artifact.filename).toLowerCase()
  );
}

async function localFileMatches(
  storagePath: string,
  expectedSize: number,
  expectedSha256: string
): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(storagePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
  if (!stat.isFile()) {
    throw new Error(`Artifact path is not a file: ${storagePath}`);
  }
  if (stat.size !== expectedSize) {
    return false;
  }
  return (await sha256File(storagePath)) === expectedSha256;
}

async function sha256File(storagePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    fs.createReadStream(storagePath),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    new Transform({
      transform(_chunk, _encoding, callback) {
        callback();
      },
    })
  );
  return hash.digest('hex');
}

async function writeResponseBodyWithHash(
  body: ReadableStream<Uint8Array>,
  tempPath: string
): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  const hashAndLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_ARTIFACT_BYTES) {
        callback(new ArtifactTransferBodyTooLargeError('Artifact response body exceeds max size'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(body as never), hashAndLimit, fs.createWriteStream(tempPath));
  return { size, sha256: hash.digest('hex') };
}

async function errorFromResponse(response: Response): Promise<Error> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = await response.text().catch(() => '');
  }
  const code =
    payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : String(payload);
  if (response.status === 409 && code === 'file_missing') {
    return new ArtifactNotYetAvailableError();
  }
  return new Error(`Artifact transfer failed with ${response.status}: ${code}`);
}

function toTransferError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  if (isConnectionError(err)) {
    return toError(err);
  }
  return new Error(String(err));
}

async function removeTempFile(tempPath: string): Promise<void> {
  try {
    await fsp.unlink(tempPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}
