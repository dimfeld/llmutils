import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { getTimDataDir } from '../../common/config_paths.js';
import { MAX_ARTIFACT_BYTES } from './constants.js';
import { ArtifactTooLargeError } from './errors.js';

export interface StoredArtifactFile {
  size: number;
  sha256: string;
  mimeType: string;
  storagePath: string;
  filename: string;
  ext: string;
}

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.m4v': 'video/x-m4v',
  '.md': 'text/markdown',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
};

export function getArtifactsRoot(): string {
  return path.join(getTimDataDir(), 'artifacts');
}

export function resolveArtifactPath(
  projectUuid: string,
  planUuid: string,
  artifactUuid: string,
  ext: string
): string {
  return path.join(getArtifactsRoot(), projectUuid, planUuid, `${artifactUuid}${ext}`);
}

function mimeTypeForExtension(ext: string): string {
  return MIME_TYPES_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

export async function storeArtifactFile(
  sourcePath: string,
  projectUuid: string,
  planUuid: string,
  artifactUuid: string
): Promise<StoredArtifactFile> {
  const resolvedSourcePath = path.resolve(process.cwd(), sourcePath);
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(resolvedSourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Artifact source file does not exist: ${resolvedSourcePath}`, {
        cause: error,
      });
    }
    throw error;
  }

  if (!stat.isFile()) {
    throw new Error(`Artifact source path is not a regular file: ${resolvedSourcePath}`);
  }
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw new ArtifactTooLargeError(stat.size);
  }

  const filename = path.basename(resolvedSourcePath);
  const ext = path.extname(filename).toLowerCase();
  const storagePath = resolveArtifactPath(projectUuid, planUuid, artifactUuid, ext);
  await fsp.mkdir(path.dirname(storagePath), { recursive: true });

  const hash = createHash('sha256');
  let size = 0;
  const hashAndLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_ARTIFACT_BYTES) {
        callback(new ArtifactTooLargeError(size));
        return;
      }

      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      fs.createReadStream(resolvedSourcePath),
      hashAndLimit,
      fs.createWriteStream(storagePath)
    );
  } catch (error) {
    await removeArtifactFile(storagePath);
    throw error;
  }

  return {
    size,
    sha256: hash.digest('hex'),
    mimeType: mimeTypeForExtension(ext),
    storagePath,
    filename,
    ext,
  };
}

export async function removeArtifactFile(storagePath: string): Promise<void> {
  try {
    await fsp.unlink(storagePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

export async function artifactFileExists(storagePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(storagePath);
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export function artifactFileExistsSync(storagePath: string): boolean {
  try {
    const stat = fs.statSync(storagePath);
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
