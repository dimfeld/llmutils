import { homedir } from 'node:os';
import { join } from 'node:path';

import { validatePath } from '../common/fs.js';
import { computePathSignature, hasValidBearerToken, isValidPathSignature } from './security.js';

/** Query parameter or trailing path segment prefix that carries the read-access signature. */
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
  return join(homedir(), '.local', 'share', 'tim', 'media-host');
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

function encodeMediaPath(relativePath: string): string {
  return relativePath.split('/').map(encodeURIComponent).join('/');
}

function buildSignedMediaUrl(relativePath: string, signature: string): string {
  return `/${encodeMediaPath(relativePath)}/${SIGNATURE_PARAM}=${encodeURIComponent(signature)}`;
}

interface SignedMediaPath {
  relativePath: string;
  signature: string | null;
}

function parseSignedMediaPath(pathname: string, url: URL): SignedMediaPath | null {
  const relativePath = normalizeMediaPath(pathname);
  if (relativePath === null) {
    return null;
  }

  const pathSegments = relativePath.split('/');
  const lastSegment = pathSegments.at(-1);
  if (lastSegment?.startsWith(`${SIGNATURE_PARAM}=`)) {
    const signature = lastSegment.slice(SIGNATURE_PARAM.length + 1);
    const unsignedPath = pathSegments.slice(0, -1).join('/');
    if (unsignedPath.length === 0) {
      return null;
    }

    return {
      relativePath: unsignedPath,
      signature,
    };
  }

  return {
    relativePath,
    signature: url.searchParams.get(SIGNATURE_PARAM),
  };
}

function logMediaRequest(
  action: 'upload' | 'view',
  status: number,
  relativePath: string | null,
  details?: Record<string, string | number>
): void {
  const detailText = details
    ? Object.entries(details)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
    : '';
  console.info(
    `[media_host] ${action} status=${status} path=${JSON.stringify(relativePath)}${detailText ? ` ${detailText}` : ''}`
  );
}

async function handleUpload(
  request: Request,
  relativePath: string,
  config: MediaHostConfig
): Promise<Response> {
  if (!hasValidBearerToken(request, config.apiKey)) {
    logMediaRequest('upload', 401, relativePath);
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let absoluteTargetPath: string;
  try {
    absoluteTargetPath = validatePath(config.storageDir, relativePath);
  } catch {
    logMediaRequest('upload', 400, relativePath);
    return jsonResponse({ error: 'Invalid path' }, 400);
  }

  const declaredLength = request.headers.get('content-length');
  if (declaredLength) {
    const declared = Number.parseInt(declaredLength, 10);
    if (Number.isInteger(declared) && declared > config.maxUploadBytes) {
      logMediaRequest('upload', 413, relativePath, { declaredBytes: declared });
      return jsonResponse({ error: 'Payload too large' }, 413);
    }
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > config.maxUploadBytes) {
    logMediaRequest('upload', 413, relativePath, { bytes: body.byteLength });
    return jsonResponse({ error: 'Payload too large' }, 413);
  }

  try {
    await Bun.write(absoluteTargetPath, body);
  } catch (error) {
    logMediaRequest('upload', 500, relativePath, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const signature = computePathSignature(relativePath, config.signingSecret);
  logMediaRequest('upload', 201, relativePath, { bytes: body.byteLength });
  return jsonResponse(
    {
      path: relativePath,
      size: body.byteLength,
      url: buildSignedMediaUrl(relativePath, signature),
    },
    201
  );
}

async function handleDownload(
  signature: string | null,
  relativePath: string,
  config: MediaHostConfig
): Promise<Response> {
  if (!isValidPathSignature(relativePath, config.signingSecret, signature)) {
    logMediaRequest('view', 403, relativePath);
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  let absoluteTargetPath: string;
  try {
    absoluteTargetPath = validatePath(config.storageDir, relativePath);
  } catch {
    logMediaRequest('view', 400, relativePath);
    return jsonResponse({ error: 'Invalid path' }, 400);
  }

  const file = Bun.file(absoluteTargetPath);
  if (!(await file.exists())) {
    logMediaRequest('view', 404, relativePath);
    return jsonResponse({ error: 'Not Found' }, 404);
  }

  // Response infers content-type and content-length from the BunFile. Files are
  // gated behind a path-bound signature, so caches must keep responses private.
  logMediaRequest('view', 200, relativePath, { bytes: file.size });
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
      if (request.method === 'PUT' || request.method === 'POST') {
        logMediaRequest('upload', 400, null);
      } else if (request.method === 'GET') {
        logMediaRequest('view', 400, null);
      }
      return jsonResponse({ error: 'Invalid path' }, 400);
    }

    if (request.method === 'PUT' || request.method === 'POST') {
      return handleUpload(request, relativePath, config);
    }

    if (request.method === 'GET') {
      const signedMediaPath = parseSignedMediaPath(url.pathname, url);
      if (signedMediaPath === null) {
        logMediaRequest('view', 400, null);
        return jsonResponse({ error: 'Invalid path' }, 400);
      }

      return handleDownload(signedMediaPath.signature, signedMediaPath.relativePath, config);
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
