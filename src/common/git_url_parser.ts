import { createHash } from 'node:crypto';
import * as path from 'node:path';

export type GitHostingService = 'github' | 'gitlab' | 'bitbucket' | 'unknown';

export interface ParsedGitRemote {
  /** Original remote string (trimmed). */
  original: string;
  /** Protocol used in the remote definition, if available. */
  protocol: string;
  /** Hostname extracted from the remote, if available. */
  host?: string;
  /** Optional port defined on the remote. */
  port?: number;
  /** Username (for SSH / URL formats) if present. */
  username?: string;
  /** Normalized path without leading slash or trailing `.git`. */
  path: string;
  /** Individual path segments with the repository name normalized. */
  pathSegments: string[];
  /** Portion of the path representing the owner/namespace. */
  ownerPath?: string;
  /** Repository name without `.git` suffix. */
  repository?: string;
  /** Fully qualified owner/repository path. */
  fullName?: string;
  /** Detected hosting provider when known. */
  service: GitHostingService;
}

const SCP_LIKE_REGEX = /^(?:(?<username>[^@]+)@)?(?<host>[^:]+):(?<path>.+)$/;
const SAFE_SEGMENT_PATTERN = /[^A-Za-z0-9._-]+/g;

function detectService(host?: string): GitHostingService {
  if (!host) {
    return 'unknown';
  }
  const normalized = host.toLowerCase();
  if (normalized === 'github.com' || normalized.endsWith('.github.com')) {
    return 'github';
  }
  if (normalized === 'gitlab.com' || normalized.includes('gitlab')) {
    return 'gitlab';
  }
  if (normalized === 'bitbucket.org' || normalized.includes('bitbucket')) {
    return 'bitbucket';
  }
  return 'unknown';
}

function sanitizeSegment(segment: string, index: number): string {
  let sanitized = segment.replace(SAFE_SEGMENT_PATTERN, '-');
  sanitized = sanitized.replace(/^-+/, '').replace(/-+$/, '').replace(/-+/g, '-');
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    sanitized = `segment${index + 1}`;
  }
  if (sanitized.startsWith('.')) {
    sanitized = sanitized.replace(/^\.+/, 'dot-');
  }
  return sanitized;
}

function sanitizeName(parts: string[]): string {
  const sanitizedParts = parts.map((part, index) => sanitizeSegment(part, index)).filter(Boolean);
  if (sanitizedParts.length === 0) {
    return 'repository';
  }
  return sanitizedParts.join('__');
}

function normalizeSeparators(value: string): string {
  return value.includes('\\') ? value.split('\\').join('/') : value;
}

function collapseRepeatedSlashes(value: string): string {
  let result = '';
  let previousWasSlash = false;
  for (const char of value) {
    if (char === '/') {
      if (previousWasSlash) {
        continue;
      }
      previousWasSlash = true;
    } else {
      previousWasSlash = false;
    }
    result += char;
  }
  return result;
}

function removeLeadingSlashes(value: string): string {
  let result = value;
  while (result.startsWith('/')) {
    result = result.slice(1);
  }
  return result;
}

function normalizePath(pathname: string): string {
  if (!pathname) {
    return '';
  }
  const cleanedSeparators = normalizeSeparators(pathname);
  const withoutLeading = removeLeadingSlashes(cleanedSeparators);
  let decoded = withoutLeading;
  try {
    decoded = decodeURI(withoutLeading);
  } catch {
    // Leave the original path when decoding fails due to invalid escape sequences
  }
  return collapseRepeatedSlashes(decoded);
}

function stripGitSuffix(segment: string): string {
  const withoutFragment = segment.split('#', 1)[0];
  const withoutQuery = withoutFragment.split('?', 1)[0];
  return withoutQuery.replace(/\.git$/i, '');
}

function asPathSegments(normalizedPath: string): string[] {
  if (!normalizedPath) {
    return [];
  }
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length === 0) {
    return [];
  }
  const last = segments[segments.length - 1];
  segments[segments.length - 1] = stripGitSuffix(last);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function buildFullName(segments: string[]): {
  ownerPath?: string;
  repository?: string;
  fullName?: string;
} {
  if (segments.length === 0) {
    return {};
  }
  if (segments.length === 1) {
    const repository = segments[0];
    return { repository, fullName: repository };
  }
  const repository = segments[segments.length - 1];
  const ownerPathSegments = segments.slice(0, -1);
  const ownerPath = ownerPathSegments.join('/');
  return { ownerPath, repository, fullName: `${ownerPath}/${repository}` };
}

export function parseGitRemoteUrl(remoteInput: string): ParsedGitRemote | null {
  const remote = remoteInput.trim();
  if (!remote) {
    return null;
  }

  let protocol = 'unknown';
  let host: string | undefined;
  let port: number | undefined;
  let username: string | undefined;
  let rawPath = '';

  if (remote.includes('://')) {
    try {
      const parsedUrl = new URL(remote);
      protocol = parsedUrl.protocol.replace(/:$/, '') || 'unknown';
      host = parsedUrl.hostname || undefined;
      port = parsedUrl.port ? Number(parsedUrl.port) : undefined;
      username = parsedUrl.username || undefined;
      rawPath = parsedUrl.pathname || '';
    } catch {
      // Ignore URL parsing failures and fall back to other strategies
    }
  }

  if (!rawPath && !host) {
    const isWindowsPath = /^[A-Za-z]:[\\/]/.test(remote);
    if (!isWindowsPath) {
      const scpMatch = remote.match(SCP_LIKE_REGEX);
      if (scpMatch?.groups) {
        protocol = 'ssh';
        host = scpMatch.groups.host;
        username = scpMatch.groups.username;
        rawPath = scpMatch.groups.path || '';
      }
    }
  }

  if (!rawPath && !host) {
    // Treat as local path (relative or absolute)
    protocol = 'file';
    rawPath = remote;
  }

  const normalizedPath = normalizePath(rawPath);
  const pathSegments = asPathSegments(normalizedPath);
  const { ownerPath, repository, fullName } = buildFullName(pathSegments);

  return {
    original: remote,
    protocol,
    host,
    port,
    username,
    path: normalizedPath,
    pathSegments,
    ownerPath,
    repository,
    fullName,
    service: detectService(host),
  };
}

export interface DeriveRepositoryNameOptions {
  /** Optional fallback when the parsed remote does not provide enough information. */
  fallbackName?: string;
  /** Optional hash input to help make long names unique when truncated. */
  uniqueSalt?: string;
  /** Optional maximum length. When exceeded, names are truncated with an appended hash. */
  maxLength?: number;
}

function maybeHash(input: string, salt?: string, maxLength?: number): string {
  if (!maxLength || input.length <= maxLength) {
    return input;
  }
  const hashSource = salt ? `${input}:${salt}` : input;
  const hash = createHash('sha256').update(hashSource).digest('hex').slice(0, 8);
  const sliceLength = Math.max(0, maxLength - hash.length - 1);
  const prefix = input.slice(0, sliceLength);
  const trimmedPrefix = prefix.replace(/-+$/, '');
  return `${trimmedPrefix}-${hash}`;
}

export function deriveRepositoryName(
  parsed: ParsedGitRemote | null,
  options: DeriveRepositoryNameOptions = {}
): string {
  const parts: string[] = [];

  if (parsed?.host) {
    parts.push(parsed.host.toLowerCase());
    if (parsed.port) {
      parts.push(`port-${parsed.port}`);
    }
  }

  if (parsed?.fullName) {
    parts.push(...parsed.fullName.split('/'));
  } else if (parsed?.pathSegments?.length) {
    parts.push(...parsed.pathSegments);
  }

  if (parts.length === 0) {
    const fallbackSource = options.fallbackName?.trim();
    if (fallbackSource) {
      parts.push(...fallbackSource.split(/[\/]+/));
    }
  }

  const sanitized = sanitizeName(parts);
  const uniqueSalt = options.uniqueSalt ?? parsed?.original ?? options.fallbackName ?? '';
  return maybeHash(sanitized, uniqueSalt, options.maxLength);
}

export function fallbackRepositoryNameFromGitRoot(gitRoot: string): string {
  const base = path.basename(gitRoot);
  return sanitizeName([base]);
}
