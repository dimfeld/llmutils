import { homedir } from 'node:os';
import { join } from 'node:path';

import { validatePath } from '../common/fs.js';
import { computePathSignature, hasValidBearerToken, isValidPathSignature } from './security.js';

/** Query parameter that carries the salted-hash signature for read access. */
export const SIGNATURE_PARAM = 'sig';

export interface MediaHostConfig {
  port: number;
  host: string;
  /** Directory under which all uploaded files are stored. */
  storageDir: string;
  /** Bearer token required to upload files. */
  apiKey: string;
  /** Secret (salt) used to sign and verify access to file paths. */
  signingSecret: string;
  /** Maximum upload size in bytes. Larger uploads are rejected with 413. */
  maxUploadBytes: number;
}

function getDefaultStorageDir(): string {
  return join(homedir(), '.cache', 'tim', 'media-host');
}

export function loadConfigFromEnv(): MediaHostConfig {
  const apiKey = process.env.MEDIA_HOST_API_KEY;
  const signingSecret = process.env.MEDIA_HOST_SIGNING_SECRET;

  if (!apiKey) {
    throw new Error('MEDIA_HOST_API_KEY is required');
  }
  if (!signingSecret) {
    throw new Error('MEDIA_HOST_SIGNING_SECRET is required');
  }

  const port = Number.parseInt(process.env.MEDIA_HOST_PORT ?? '8125', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid MEDIA_HOST_PORT: ${process.env.MEDIA_HOST_PORT}`);
  }

  const maxUploadBytes = Number.parseInt(
    process.env.MEDIA_HOST_MAX_UPLOAD_BYTES ?? `${100 * 1024 * 1024}`,
    10
  );
  if (!Number.isInteger(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new Error(
      `Invalid MEDIA_HOST_MAX_UPLOAD_BYTES: ${process.env.MEDIA_HOST_MAX_UPLOAD_BYTES}`
    );
  }

  return {
    port,
    host: process.env.MEDIA_HOST_HOST ?? '0.0.0.0',
    storageDir: process.env.MEDIA_HOST_DIR ?? getDefaultStorageDir(),
    apiKey,
    signingSecret,
    maxUploadBytes,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Normalizes a request URL pathname into a canonical storage-relative path:
 * decodes percent-encoding and strips leading slashes. Returns null when the
 * pathname does not name a file (e.g. it is empty or ends in a slash).
 *
 * Path-traversal safety is enforced separately via {@link validatePath}; this
 * function only produces the canonical string that is both signed and resolved.
 */
export function normalizeMediaPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  // Reject NUL bytes outright — they can truncate paths at the filesystem layer.
  if (decoded.includes('\0')) {
    return null;
  }

  const relativePath = decoded.replace(/^\/+/, '');
  if (relativePath.length === 0 || relativePath.endsWith('/')) {
    return null;
  }

  return relativePath;
}

async function handleUpload(
  request: Request,
  relativePath: string,
  config: MediaHostConfig
): Promise<Response> {
  if (!hasValidBearerToken(request, config.apiKey)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let absoluteTargetPath: string;
  try {
    absoluteTargetPath = validatePath(config.storageDir, relativePath);
  } catch {
    return jsonResponse({ error: 'Invalid path' }, 400);
  }

  const declaredLength = request.headers.get('content-length');
  if (declaredLength) {
    const declared = Number.parseInt(declaredLength, 10);
    if (Number.isInteger(declared) && declared > config.maxUploadBytes) {
      return jsonResponse({ error: 'Payload too large' }, 413);
    }
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > config.maxUploadBytes) {
    return jsonResponse({ error: 'Payload too large' }, 413);
  }

  await Bun.write(absoluteTargetPath, body);

  const signature = computePathSignature(relativePath, config.signingSecret);
  return jsonResponse(
    {
      path: relativePath,
      size: body.byteLength,
      url: `/${relativePath}?${SIGNATURE_PARAM}=${signature}`,
    },
    201
  );
}

async function handleDownload(
  url: URL,
  relativePath: string,
  config: MediaHostConfig
): Promise<Response> {
  const signature = url.searchParams.get(SIGNATURE_PARAM);
  if (!isValidPathSignature(relativePath, config.signingSecret, signature)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  let absoluteTargetPath: string;
  try {
    absoluteTargetPath = validatePath(config.storageDir, relativePath);
  } catch {
    return jsonResponse({ error: 'Invalid path' }, 400);
  }

  const file = Bun.file(absoluteTargetPath);
  if (!(await file.exists())) {
    return jsonResponse({ error: 'Not Found' }, 404);
  }

  // Response infers content-type and content-length from the BunFile. Files are
  // gated behind a path-bound signature, so caches must keep responses private.
  return new Response(file, {
    headers: {
      'cache-control': 'private, max-age=3600',
    },
  });
}

/**
 * Builds the request handler for the media host. Exposed separately from
 * {@link buildServer} so it can be exercised directly in tests.
 */
export function createFetchHandler(
  config: MediaHostConfig
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === '/healthz' && request.method === 'GET') {
      return jsonResponse({ ok: true });
    }

    const relativePath = normalizeMediaPath(url.pathname);
    if (relativePath === null) {
      return jsonResponse({ error: 'Invalid path' }, 400);
    }

    if (request.method === 'PUT' || request.method === 'POST') {
      return handleUpload(request, relativePath, config);
    }

    if (request.method === 'GET') {
      return handleDownload(url, relativePath, config);
    }

    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  };
}

export function buildServer(config: MediaHostConfig): ReturnType<typeof Bun.serve> {
  const handler = createFetchHandler(config);

  return Bun.serve({
    port: config.port,
    hostname: config.host,
    // Allow uploads up to the configured maximum (Bun defaults to 128 MiB).
    maxRequestBodySize: config.maxUploadBytes,
    fetch: handler,
    error(error) {
      console.error('[media_host] Server error', error);
      return jsonResponse({ error: 'Internal Server Error' }, 500);
    },
  });
}

function main(): void {
  const config = loadConfigFromEnv();
  const server = buildServer(config);

  console.log(
    `[media_host] listening on http://${server.hostname}:${server.port} storing files under ${config.storageDir}`
  );
}

if (import.meta.main) {
  main();
}
