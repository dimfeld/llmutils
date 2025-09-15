// Command handler for 'rmplan add-progress-note'
// Adds a timestamped progress note to a plan's progressNotes array

import { readPlanFile, resolvePlanFile, writePlanFile } from '../plans.js';
import { log, warn } from '../../logging.js';
import { open, unlink, stat, readFile } from 'node:fs/promises';
import { loadEffectiveConfig } from '../configLoader.js';

export async function handleAddProgressNoteCommand(planFile: string, note: string, command: any) {
  if (!planFile || typeof planFile !== 'string') {
    throw new Error('You must specify a plan file path or plan ID');
  }
  if (!note || typeof note !== 'string' || note.trim().length === 0) {
    throw new Error('You must provide a non-empty progress note');
  }

  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  // Resolve file or ID to an absolute plan file path
  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);

  // Optimistic concurrency with retry: merge-on-write and verify
  const timestamp = new Date().toISOString();
  const entry = { timestamp, text: note };
  const maxRetries = 5;

  const lockPath = `${resolvedPlanFile}.lock`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const current = await readPlanFile(resolvedPlanFile);
    const notes = Array.isArray(current.progressNotes) ? current.progressNotes : [];

    // Append and de-duplicate by timestamp+text
    const merged = [...notes, entry].filter((value, index, self) => {
      return (
        index === self.findIndex((n) => n.timestamp === value.timestamp && n.text === value.text)
      );
    });
    const maxStored = config.progressNotes?.maxStored ?? 200;

    // Acquire a simple advisory lock to serialize writes
    let lockHandle: any = null;
    try {
      lockHandle = await open(lockPath, 'wx');
      // Write our PID and a timestamp for stale-lock recovery
      try {
        await lockHandle.writeFile(`${process.pid}\n${Date.now()}\n`);
      } catch {}
    } catch {
      // Someone else holds the lock; perform stale-lock recovery if needed
      try {
        const info = await stat(lockPath);
        const now = Date.now();
        const ttlMs = 2 * 60 * 1000; // 2 minutes TTL
        const age = now - info.mtimeMs;
        if (age > ttlMs) {
          // Try to read PID and see if the process is alive; if not, remove the lock
          try {
            const content = await readFile(lockPath, 'utf8');
            const [pidLine] = content.split(/\r?\n/);
            const pid = Number(pidLine);
            let alive = false;
            if (Number.isFinite(pid) && pid > 0) {
              try {
                process.kill(pid, 0);
                alive = true;
              } catch {
                alive = false;
              }
            }
            if (!alive) {
              warn(
                `Stale lock detected at ${lockPath} (age ${Math.round(age / 1000)}s); removing.`
              );
              await unlink(lockPath);
            }
          } catch {
            // If we can't read it, still try removing after TTL
            warn(`Stale lock detected at ${lockPath} (age ${Math.round(age / 1000)}s); removing.`);
            try {
              await unlink(lockPath);
            } catch {}
          }
        }
      } catch {
        // If stat fails, the lock likely disappeared; just retry
      }
      await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 25)));
      continue;
    }

    try {
      // Merge with latest state just before writing to avoid last-writer-wins
      const latestBeforeWrite = await readPlanFile(resolvedPlanFile);
      const latestNotes = Array.isArray(latestBeforeWrite.progressNotes)
        ? latestBeforeWrite.progressNotes
        : [];
      const union = computeProgressNotesUnion(latestNotes, merged, entry, maxStored);

      // Write the most up-to-date object to avoid clobbering other fields.
      latestBeforeWrite.progressNotes = union;
      await writePlanFile(resolvedPlanFile, latestBeforeWrite);

      // Re-read to ensure our note and union survived any concurrent writes
      const after = await readPlanFile(resolvedPlanFile);
      const afterNotes = after.progressNotes || [];
      const unionAllPresent = union.every((u) =>
        afterNotes.some((n) => n.timestamp === u.timestamp && n.text === u.text)
      );
      if (unionAllPresent) {
        log(`Added progress note to ${resolvedPlanFile}`);
        return;
      }
      // Else, retry with latest content (TOCTOU guard)
    } finally {
      try {
        if (lockHandle) await lockHandle.close();
      } catch {}
      try {
        await unlink(lockPath);
      } catch {}
    }
  }

  // If we exit the retry loop without confirming success, report failure
  throw new Error(
    `Failed to add progress note after ${maxRetries} attempts due to concurrent modifications`
  );
}

export function computeProgressNotesUnion(
  latestNotes: Array<{ timestamp: string; text: string }> | undefined,
  localMerged: Array<{ timestamp: string; text: string }> | undefined,
  entry: { timestamp: string; text: string },
  maxStored?: number
): Array<{ timestamp: string; text: string }> {
  const ln = Array.isArray(latestNotes) ? latestNotes : [];
  const lm = Array.isArray(localMerged) ? localMerged : [];
  // Avoid re-introducing stale notes that were pruned by rotation in latestBeforeWrite.
  // Allow only notes that are already in latestNotes plus our new entry.
  const key = (n: { timestamp: string; text: string }) => `${n.timestamp}|${n.text}`;
  const allowedKeys = new Set<string>(ln.map(key));
  allowedKeys.add(key(entry));
  const combined = [...ln, ...lm];
  let union = combined.filter((n) => allowedKeys.has(key(n)));
  // De-dupe while preserving order
  const seen = new Set<string>();
  union = union.filter((n) => {
    const k = key(n);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Apply rotation to keep only the most recent notes by array order
  if (typeof maxStored === 'number' && maxStored > 0 && union.length > maxStored) {
    union = union.slice(-maxStored);
  }
  return union;
}
