import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { getTimConfigRoot } from '../../common/config_paths.js';

interface QueueEntry {
  id: number;
  pid: number;
  active: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** A local FIFO queue shared by command processes through SQLite file locks. */
export async function withReviewQueue<T>(options: {
  concurrency: number;
  run: () => Promise<T>;
  onStart?: () => void;
  queuePath?: string;
  pollIntervalMs?: number;
}): Promise<T> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('Review concurrency must be a positive integer.');
  }
  const queuePath = options.queuePath ?? path.join(getTimConfigRoot(), 'review-queue.sqlite');
  await mkdir(path.dirname(queuePath), { recursive: true });
  const db = new Database(queuePath, { create: true });
  let id: number | undefined;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS review_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pid INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0
    )`);
    id = Number(
      db.query('INSERT INTO review_queue (pid) VALUES (?)').run(process.pid).lastInsertRowid
    );
    const tryStart = db.transaction((): boolean => {
      const entries = db.query<QueueEntry, []>('SELECT * FROM review_queue ORDER BY id').all();
      let active = 0;
      let waitingAhead = 0;
      for (const entry of entries) {
        if (!isProcessAlive(entry.pid)) {
          db.query('DELETE FROM review_queue WHERE id = ?').run(entry.id);
          continue;
        }
        if (entry.active) active++;
        else if (entry.id < id!) waitingAhead++;
      }
      if (active + waitingAhead >= options.concurrency) return false;
      db.query('UPDATE review_queue SET active = 1 WHERE id = ?').run(id!);
      return true;
    });
    while (!tryStart.immediate()) {
      await new Promise<void>((resolve): void => {
        setTimeout(resolve, options.pollIntervalMs ?? 1000);
      });
    }
    options.onStart?.();
    return await options.run();
  } finally {
    try {
      if (id !== undefined) db.query('DELETE FROM review_queue WHERE id = ?').run(id);
    } finally {
      db.close();
    }
  }
}
