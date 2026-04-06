import { watch, watchFile, unwatchFile, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { warn } from '../logging.js';

const PLAN_WATCH_DEBOUNCE_MS = 300;

export interface PlanFileWatcher {
  /** Stop watching and emit any final content synchronously if possible. */
  close(): void;
  /** Stop watching and emit final content asynchronously to ensure it's delivered. */
  closeAndFlush(): Promise<void>;
}

export function stripPlanFrontmatter(content: string): string | null {
  const normalized = content.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) {
    return normalized.trim();
  }

  const endDelimiterIndex = normalized.indexOf('\n---\n', 4);
  if (endDelimiterIndex === -1) {
    // Incomplete frontmatter (e.g. mid-write) — skip this update
    return null;
  }

  return normalized.substring(endDelimiterIndex + 5).trim();
}

export function watchPlanFile(
  filePath: string,
  onContent: (content: string) => void
): PlanFileWatcher {
  const parentDir = path.dirname(filePath);
  const targetBasename = path.basename(filePath);
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let lastContent: string | null = null;

  async function readAndEmit(): Promise<void> {
    try {
      const nextContent = stripPlanFrontmatter(await readFile(filePath, 'utf8'));
      if (nextContent === null || nextContent === lastContent) {
        return;
      }

      lastContent = nextContent;
      onContent(nextContent);
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return;
      }

      warn(`Failed to read watched plan file ${filePath}: ${err as Error}`);
    }
  }

  async function emitCurrentContent(): Promise<void> {
    if (closed) {
      return;
    }
    await readAndEmit();
  }

  function scheduleEmit(): void {
    if (closed) {
      return;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void emitCurrentContent();
    }, PLAN_WATCH_DEBOUNCE_MS);
  }

  try {
    watcher = watch(parentDir, (_eventType, filename) => {
      if (filename !== null && path.basename(String(filename)) !== targetBasename) {
        return;
      }

      scheduleEmit();
    });
    watcher.on('error', (err) => {
      warn(`Plan file watcher error for ${filePath}: ${err as Error}`);
    });
  } catch (err) {
    warn(`Failed to watch plan file ${filePath} via ${parentDir}: ${err as Error}`);
  }

  watchFile(filePath, { interval: 100 }, () => {
    scheduleEmit();
  });

  void emitCurrentContent();

  function stopWatcher(): void {
    closed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    watcher?.close();
    watcher = null;
    unwatchFile(filePath);
  }

  return {
    close() {
      stopWatcher();
    },
    async closeAndFlush() {
      // Stop the watcher first to prevent concurrent emissions
      stopWatcher();
      // Then do one final read to capture any pending content
      await readAndEmit();
    },
  };
}
