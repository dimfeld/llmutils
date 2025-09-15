// Command handler for 'rmplan add-progress-note'
// Adds a timestamped progress note to a plan's progressNotes array

import { readPlanFile, resolvePlanFile, writePlanFile } from '../plans.js';
import { log } from '../../logging.js';
import { open, unlink } from 'node:fs/promises';
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

    // If identical note already present, we're done
    if (notes.some((n) => n.timestamp === entry.timestamp && n.text === entry.text)) {
      log(`Added progress note to ${resolvedPlanFile}`);
      return;
    }

    // Append and de-duplicate by timestamp+text
    const merged = [...notes, entry].filter((value, index, self) => {
      return (
        index === self.findIndex((n) => n.timestamp === value.timestamp && n.text === value.text)
      );
    });
    const maxStored = config.progressNotes?.maxStored;

    // Acquire a simple advisory lock to serialize writes
    let lockHandle: any = null;
    try {
      lockHandle = await open(lockPath, 'wx');
    } catch {
      // Someone else holds the lock; wait a bit and retry
      await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 25)));
      continue;
    }

    try {
      // Merge with latest state just before writing to avoid last-writer-wins
      const latestBeforeWrite = await readPlanFile(resolvedPlanFile);
      const latestNotes = Array.isArray(latestBeforeWrite.progressNotes)
        ? latestBeforeWrite.progressNotes
        : [];
      // Build a last-wins union to avoid re-introducing discarded notes
      // Combine existing latestNotes first, then our merged (which ends with the new entry)
      const combined = [...latestNotes, ...merged];
      const key = (n: { timestamp: string; text: string }) => `${n.timestamp}|${n.text}`;
      const map = new Map<string, (typeof combined)[number]>();
      for (const n of combined) {
        map.set(key(n), n); // last occurrence wins
      }
      let union = Array.from(map.values());
      // Apply rotation to keep only the most recent notes by array order
      if (typeof maxStored === 'number' && maxStored > 0 && union.length > maxStored) {
        // Keep the most recent notes by array order
        union = union.slice(-maxStored);
      }

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
