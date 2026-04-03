import { watch, type FSWatcher } from 'node:fs';

import { warn } from '../logging.js';

const PLAN_WATCH_DEBOUNCE_MS = 300;

export interface PlanFileWatcher {
  close(): void;
}

export function stripPlanFrontmatter(content: string): string | null {
  if (!content.startsWith('---\n')) {
    return content.trim();
  }

  const endDelimiterIndex = content.indexOf('\n---\n', 4);
  if (endDelimiterIndex === -1) {
    // Incomplete frontmatter (e.g. mid-write) — skip this update
    return null;
  }

  return content.substring(endDelimiterIndex + 5).trim();
}

export function watchPlanFile(
  filePath: string,
  onContent: (content: string) => void
): PlanFileWatcher {
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let lastContent: string | null = null;

  async function emitCurrentContent(): Promise<void> {
    if (closed) {
      return;
    }

    try {
      const nextContent = stripPlanFrontmatter(await Bun.file(filePath).text());
      if (closed || nextContent === null || nextContent === lastContent) {
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
    watcher = watch(filePath, () => {
      scheduleEmit();
    });
    watcher.on('error', (err) => {
      warn(`Plan file watcher error for ${filePath}: ${err as Error}`);
    });
  } catch (err) {
    warn(`Failed to watch plan file ${filePath}: ${err as Error}`);
    return {
      close() {
        closed = true;
      },
    };
  }

  void emitCurrentContent();

  return {
    close() {
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      watcher?.close();
      watcher = null;
    },
  };
}
