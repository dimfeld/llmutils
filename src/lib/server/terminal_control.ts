import * as fs from 'node:fs/promises';

import which from 'which';

import { spawnAndLogOutput } from '../../common/process.js';
import type { SpawnAndLogOutputResult } from '../../common/process.js';

export interface TerminalSessionTarget {
  terminalType?: string | null;
  terminalPaneId?: string | null;
}

interface WeztermPaneEntry {
  pane_id?: number | string;
  workspace?: string | null;
}

const WEZTERM_CANDIDATE_PATHS = ['/opt/homebrew/bin/wezterm', '/usr/local/bin/wezterm'] as const;

export interface TerminalControlDeps {
  fileExists: (path: string) => Promise<boolean>;
  platform: NodeJS.Platform;
  spawnAndLogOutput: (
    cmd: string[],
    options?: { quiet?: boolean }
  ) => Promise<SpawnAndLogOutputResult>;
  which: (command: string, options: { nothrow: true }) => Promise<string | null>;
}

const DEFAULT_TERMINAL_CONTROL_DEPS: TerminalControlDeps = {
  fileExists,
  platform: process.platform,
  spawnAndLogOutput,
  which: (command, options) => which(command, options),
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveWeztermPath(deps: TerminalControlDeps): Promise<string> {
  const resolved = await deps.which('wezterm', { nothrow: true });
  if (resolved) {
    return resolved;
  }

  for (const candidate of WEZTERM_CANDIDATE_PATHS) {
    if (await deps.fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error('wezterm executable not found');
}

function parseWeztermPaneList(stdout: string): WeztermPaneEntry[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Failed to parse wezterm pane list');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Unexpected wezterm pane list response');
  }

  return parsed as WeztermPaneEntry[];
}

function paneMatches(pane: WeztermPaneEntry, paneId: string): boolean {
  return pane.pane_id != null && String(pane.pane_id) === paneId;
}

async function switchWeztermWorkspace(
  weztermPath: string,
  workspaceName: string,
  deps: TerminalControlDeps
): Promise<void> {
  const encodedArgs = Buffer.from(JSON.stringify({ workspace: workspaceName }), 'utf8').toString(
    'base64'
  );
  const switchCommand = `printf '\\033]1337;SetUserVar=switch-workspace=${encodedArgs}\\007' && sleep 0.1`;

  const result = await deps.spawnAndLogOutput(
    [weztermPath, 'cli', 'spawn', '--', '/bin/sh', '-c', switchCommand],
    { quiet: true }
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || 'Failed to switch wezterm workspace');
  }
}

async function activateWeztermPane(
  weztermPath: string,
  paneId: string,
  deps: TerminalControlDeps
): Promise<void> {
  const result = await deps.spawnAndLogOutput(
    [weztermPath, 'cli', 'activate-pane', '--pane-id', paneId],
    { quiet: true }
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || 'Failed to activate wezterm pane');
  }
}

async function bringWeztermToFront(deps: TerminalControlDeps): Promise<void> {
  if (deps.platform !== 'darwin') {
    return;
  }

  await deps.spawnAndLogOutput(['open', '-a', 'WezTerm'], { quiet: true });
}

export async function focusTerminalPane(
  target: TerminalSessionTarget,
  deps: TerminalControlDeps = DEFAULT_TERMINAL_CONTROL_DEPS
): Promise<void> {
  if (target.terminalType !== 'wezterm' || !target.terminalPaneId?.trim()) {
    throw new Error('Session does not have a focusable wezterm pane');
  }

  const paneId = target.terminalPaneId.trim();
  const weztermPath = await resolveWeztermPath(deps);

  const listResult = await deps.spawnAndLogOutput(
    [weztermPath, 'cli', 'list', '--format', 'json'],
    {
      quiet: true,
    }
  );

  if (listResult.exitCode !== 0) {
    throw new Error(listResult.stderr.trim() || 'Failed to list wezterm panes');
  }

  const panes = parseWeztermPaneList(listResult.stdout);
  const pane = panes.find((entry) => paneMatches(entry, paneId));

  if (!pane) {
    throw new Error(`WezTerm pane ${paneId} not found`);
  }

  const workspaceName = pane.workspace?.trim();
  if (!workspaceName) {
    throw new Error(`No workspace found for WezTerm pane ${paneId}`);
  }

  await switchWeztermWorkspace(weztermPath, workspaceName, deps);
  await activateWeztermPane(weztermPath, paneId, deps);
  await bringWeztermToFront(deps);
}
