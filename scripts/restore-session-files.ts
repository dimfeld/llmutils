#!/usr/bin/env bun

import * as path from 'node:path';

import { listProcesses, type ProcessInfo } from '../src/common/process_listing.js';
import {
  getTimSessionDir,
  unregisterSessionInfoFileCleanup,
  writeSessionInfoFile,
  type SessionInfoFile,
} from '../src/tim/session_server/runtime_dir.js';

const SESSION_PATH = '/tim-agent';
const DEFAULT_TIMEOUT_MS = 3_000;

interface SessionInfoMessage {
  type: 'session_info';
  sessionId: string;
  command: string;
  interactive?: boolean;
  pty?: boolean;
  cols?: number;
  rows?: number;
  hidePlanDetails?: boolean;
  planId?: number;
  planUuid?: string;
  planTitle?: string;
  linkedPlanId?: number;
  linkedPlanUuid?: string;
  linkedPlanTitle?: string;
  linkedPrUrl?: string;
  linkedPrNumber?: number;
  linkedPrTitle?: string;
  workspacePath?: string;
  gitRemote?: string;
  terminalPaneId?: string;
  terminalType?: string;
  buildSha?: string;
  buildTime?: string;
  binaryPath?: string;
}

interface RestoreOptions {
  dryRun: boolean;
  timeoutMs: number;
}

function printUsage(): void {
  console.log(`Usage: bun scripts/restore-session-files.ts [options]

Finds live tim agent processes, queries their local WebSocket servers, and
recreates missing session files.

Options:
  --dry-run          Show the files that would be written without writing them.
  --timeout <ms>    WebSocket timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}).
  -h, --help        Show this help.`);
}

function parseOptions(argv: string[]): RestoreOptions {
  let dryRun = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--timeout') {
      const value = argv[index + 1];
      index += 1;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid timeout: ${value ?? '<missing>'}`);
      }
      timeoutMs = parsed;
      continue;
    }
    if (argument === '-h' || argument === '--help') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return { dryRun, timeoutMs };
}

function runCommand(args: string[]): { output: string; exitCode: number } {
  const result = Bun.spawnSync(args, {
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    output: new TextDecoder().decode(result.stdout),
    exitCode: result.exitCode,
  };
}

function isTimAgentProcess(processInfo: ProcessInfo): boolean {
  return /(?:^|\/)tim\s+agent(?:-multi)?(?:\s|$)/.test(processInfo.command);
}

function findListeningPorts(pid: number): number[] {
  const result = runCommand(['lsof', '-nP', '-a', '-p', String(pid), '-i4TCP', '-sTCP:LISTEN']);
  if (result.exitCode !== 0) {
    return [];
  }

  const ports = new Set<number>();
  for (const line of result.output.split(/\r?\n/)) {
    const match = line.match(/:(\d+)\s+\(LISTEN\)\s*$/);
    if (match) {
      ports.add(Number(match[1]));
    }
  }
  return [...ports].toSorted((a, b) => a - b);
}

function parseSessionInfoMessage(value: unknown): SessionInfoMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const message = value as Partial<SessionInfoMessage>;
  if (
    message.type !== 'session_info' ||
    typeof message.sessionId !== 'string' ||
    message.sessionId.length === 0 ||
    typeof message.command !== 'string' ||
    message.command.length === 0
  ) {
    return null;
  }

  return message as SessionInfoMessage;
}

async function querySessionInfo(
  port: number,
  timeoutMs: number
): Promise<SessionInfoMessage | null> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${SESSION_PATH}`);
    let finished = false;

    const finish = (message: SessionInfoMessage | null): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      socket.close();
      resolve(message);
    };

    const timeout = setTimeout(() => finish(null), timeoutMs);
    socket.addEventListener('message', (event: MessageEvent): void => {
      try {
        const message = parseSessionInfoMessage(JSON.parse(String(event.data)) as unknown);
        if (message) {
          finish(message);
        }
      } catch {
        // Ignore non-JSON messages until the timeout.
      }
    });
    socket.addEventListener('error', () => finish(null));
  });
}

function processStartTime(processInfo: ProcessInfo): string {
  const parsed = new Date(processInfo.startTime);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function buildSessionInfoFile(
  processInfo: ProcessInfo,
  port: number,
  message: SessionInfoMessage
): SessionInfoFile {
  const { type, ...sessionInfo } = message;
  void type;
  return {
    ...sessionInfo,
    pid: processInfo.pid,
    port,
    hostname: '127.0.0.1',
    startedAt: processStartTime(processInfo),
  };
}

async function restoreProcess(processInfo: ProcessInfo, options: RestoreOptions): Promise<boolean> {
  const ports = findListeningPorts(processInfo.pid);
  for (const port of ports) {
    const message = await querySessionInfo(port, options.timeoutMs);
    if (!message) {
      continue;
    }

    const info = buildSessionInfoFile(processInfo, port, message);
    const filePath = path.join(getTimSessionDir(), `${processInfo.pid}.json`);
    if (options.dryRun) {
      console.log(`[dry-run] would write ${filePath}`);
      console.log(JSON.stringify(info, null, 2));
    } else {
      const writtenPath = writeSessionInfoFile(info);
      // This script writes files for other processes. Do not let the helper's
      // exit cleanup remove them when this short-lived script exits.
      unregisterSessionInfoFileCleanup(processInfo.pid);
      console.log(`restored ${writtenPath}`);
    }
    return true;
  }

  console.warn(`skipped pid ${processInfo.pid}: no responsive session server`);
  return false;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const processes = listProcesses().filter(isTimAgentProcess);

  if (processes.length === 0) {
    console.log('No tim agent processes found.');
    return;
  }

  let restored = 0;
  for (const processInfo of processes) {
    if (await restoreProcess(processInfo, options)) {
      restored += 1;
    }
  }
  console.log(`Restored ${restored} of ${processes.length} tim agent session file(s).`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
