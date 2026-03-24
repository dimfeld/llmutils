import * as fs from 'node:fs';
import * as path from 'node:path';

import { getTimCacheDir } from '../../common/config_paths.js';

export interface SessionInfoFile {
  sessionId: string;
  pid: number;
  port: number;
  hostname?: string;
  command: string;
  workspacePath?: string;
  planId?: number;
  planUuid?: string;
  planTitle?: string;
  gitRemote?: string;
  startedAt: string;
  token?: boolean;
}

const cleanupHandlersByPid = new Map<number, () => void>();
let tmpCounter = 0;

function getSessionInfoFilePath(pid: number): string {
  return path.join(getTimSessionDir(), `${pid}.json`);
}

function parseSessionInfoFile(value: unknown): SessionInfoFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Session info file must be a JSON object');
  }

  const data = value as Record<string, unknown>;
  if (typeof data.sessionId !== 'string') {
    throw new Error('Session info file is missing sessionId');
  }
  if (typeof data.pid !== 'number' || !Number.isInteger(data.pid) || data.pid <= 0) {
    throw new Error('Session info file has invalid pid');
  }
  if (
    typeof data.port !== 'number' ||
    !Number.isInteger(data.port) ||
    data.port < 0 ||
    data.port > 65535
  ) {
    throw new Error('Session info file has invalid port');
  }
  if (data.hostname != null && typeof data.hostname !== 'string') {
    throw new Error('Session info file has invalid hostname');
  }
  if (typeof data.command !== 'string') {
    throw new Error('Session info file is missing command');
  }
  if (typeof data.startedAt !== 'string') {
    throw new Error('Session info file is missing startedAt');
  }
  if (data.workspacePath != null && typeof data.workspacePath !== 'string') {
    throw new Error('Session info file has invalid workspacePath');
  }
  if (data.planId != null && (typeof data.planId !== 'number' || !Number.isInteger(data.planId))) {
    throw new Error('Session info file has invalid planId');
  }
  if (data.planUuid != null && typeof data.planUuid !== 'string') {
    throw new Error('Session info file has invalid planUuid');
  }
  if (data.planTitle != null && typeof data.planTitle !== 'string') {
    throw new Error('Session info file has invalid planTitle');
  }
  if (data.gitRemote != null && typeof data.gitRemote !== 'string') {
    throw new Error('Session info file has invalid gitRemote');
  }
  if (data.token != null && typeof data.token !== 'boolean') {
    throw new Error('Session info file has invalid token');
  }

  return {
    sessionId: data.sessionId,
    pid: data.pid,
    port: data.port,
    hostname: data.hostname as string | undefined,
    command: data.command,
    workspacePath: data.workspacePath as string | undefined,
    planId: data.planId as number | undefined,
    planUuid: data.planUuid as string | undefined,
    planTitle: data.planTitle as string | undefined,
    gitRemote: data.gitRemote as string | undefined,
    startedAt: data.startedAt,
    token: data.token as boolean | undefined,
  };
}

let sessionDirEnsured: string | null = null;

export function getTimSessionDir(): string {
  const sessionDir = path.join(getTimCacheDir(), 'sessions');
  if (sessionDirEnsured !== sessionDir) {
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    sessionDirEnsured = sessionDir;
  }
  return sessionDir;
}

export function registerSessionInfoFileCleanup(pid: number): void {
  if (cleanupHandlersByPid.has(pid)) {
    return;
  }

  // Cleanup only removes the file and unregisters. Does not call process.exit()
  // because top-level signal handlers in tim.ts own termination semantics.
  // The 'exit' event fires after process.exit() is called by those handlers.
  const cleanup = () => {
    try {
      fs.rmSync(getSessionInfoFilePath(pid), { force: true });
    } catch {
      // Ignore cleanup errors during shutdown.
    } finally {
      unregisterSessionInfoFileCleanup(pid);
    }
  };

  cleanupHandlersByPid.set(pid, cleanup);
  process.on('exit', cleanup);
}

export function unregisterSessionInfoFileCleanup(pid: number): void {
  const cleanup = cleanupHandlersByPid.get(pid);
  if (!cleanup) {
    return;
  }

  process.off('exit', cleanup);
  cleanupHandlersByPid.delete(pid);
}

export function writeSessionInfoFile(info: SessionInfoFile): string {
  const filePath = getSessionInfoFilePath(info.pid);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
  const payload = `${JSON.stringify(info, null, 2)}\n`;

  fs.writeFileSync(tmpPath, payload, 'utf8');
  fs.renameSync(tmpPath, filePath);
  registerSessionInfoFileCleanup(info.pid);

  return filePath;
}

export function removeSessionInfoFile(pid: number): void {
  unregisterSessionInfoFileCleanup(pid);
  fs.rmSync(getSessionInfoFilePath(pid), { force: true });
}

export function readSessionInfoFile(pidOrPath: number | string): SessionInfoFile {
  const filePath =
    typeof pidOrPath === 'number' ? getSessionInfoFilePath(pidOrPath) : path.resolve(pidOrPath);
  const raw = fs.readFileSync(filePath, 'utf8');
  return parseSessionInfoFile(JSON.parse(raw) as unknown);
}

export function listSessionInfoFiles(): SessionInfoFile[] {
  const sessionDir = getTimSessionDir();
  const names = fs
    .readdirSync(sessionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();

  const infos: SessionInfoFile[] = [];
  for (const name of names) {
    try {
      infos.push(readSessionInfoFile(path.join(sessionDir, name)));
    } catch {
      // Ignore malformed or concurrently replaced files while scanning.
    }
  }

  return infos;
}
