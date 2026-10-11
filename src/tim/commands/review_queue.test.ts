import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { withReviewQueue } from './review_queue.js';
import { timConfigSchema } from '../configSchema.js';

describe('review queue', (): void => {
  let tempDir: string;
  let queuePath: string;
  beforeEach(async (): Promise<void> => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-queue-'));
    queuePath = path.join(tempDir, 'queue.sqlite');
  });
  afterEach(async (): Promise<void> => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test.each([2, 3])(
    'limits reviews to %i and starts waiters in order',
    async (concurrency: number): Promise<void> => {
      const started: number[] = [];
      const releases: Array<() => void> = [];
      const jobs: Promise<void>[] = [];
      try {
        for (let i = 0; i < concurrency + 2; i++) {
          jobs.push(
            withReviewQueue({
              queuePath,
              concurrency,
              pollIntervalMs: 5,
              run: async (): Promise<void> => {
                started.push(i);
                await new Promise<void>((resolve): void => {
                  releases[i] = resolve;
                });
              },
            })
          );
          // Give each request its ticket before the next request.
          await vi.waitFor((): void => {
            const db = new Database(queuePath);
            try {
              expect(
                db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM review_queue').get()
                  ?.count
              ).toBe(i + 1);
            } finally {
              db.close();
            }
          });
        }
        expect(started).toEqual(
          Array.from({ length: concurrency }, (_: unknown, i: number): number => i)
        );
        releases[0]();
        await vi.waitFor((): void => {
          expect(started).toHaveLength(concurrency + 1);
        });
        expect(started.at(-1)).toBe(concurrency);
        releases[1]();
        await vi.waitFor((): void => {
          expect(started).toHaveLength(concurrency + 2);
        });
        expect(started.at(-1)).toBe(concurrency + 1);
      } finally {
        // Release current and future jobs even if an assertion fails.
        const timer = setInterval((): void => {
          for (const release of releases) release?.();
        }, 5);
        await Promise.all(jobs).finally((): void => {
          clearInterval(timer);
        });
      }
    }
  );

  test('releases a slot after an error', async (): Promise<void> => {
    await expect(
      withReviewQueue({
        queuePath,
        concurrency: 1,
        run: async (): Promise<void> => {
          throw new Error('review failed');
        },
      })
    ).rejects.toThrow('review failed');
    await expect(
      withReviewQueue({ queuePath, concurrency: 1, run: async (): Promise<string> => 'next' })
    ).resolves.toBe('next');
  });

  test('shares slots between processes and removes a crashed owner', async (): Promise<void> => {
    const modulePath = path.resolve('src/tim/commands/review_queue.ts');
    const script = `import { withReviewQueue } from ${JSON.stringify(modulePath)};
      await withReviewQueue({ queuePath: process.argv[1], concurrency: 1, pollIntervalMs: 5,
        run: async () => { console.log('started'); await new Promise(() => {}); } });`;
    const child = Bun.spawn([process.execPath, '-e', script, queuePath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const reader = child.stdout.getReader();
      const output = await reader.read();
      expect(new TextDecoder().decode(output.value)).toContain('started');
      reader.releaseLock();
      let started = false;
      const next = withReviewQueue({
        queuePath,
        concurrency: 1,
        pollIntervalMs: 5,
        run: async (): Promise<void> => {
          started = true;
        },
      });
      await new Promise<void>((resolve): void => {
        setTimeout(resolve, 30);
      });
      expect(started).toBe(false);
      child.kill('SIGKILL');
      await child.exited;
      await next;
      expect(started).toBe(true);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test.each([0, -1, 1.5])(
    'rejects invalid concurrency %s',
    async (concurrency: number): Promise<void> => {
      expect(
        timConfigSchema.safeParse({ reviewGuideComments: { reviewConcurrency: concurrency } })
          .success
      ).toBe(false);
      await expect(
        withReviewQueue({ queuePath, concurrency, run: async (): Promise<void> => {} })
      ).rejects.toThrow('positive integer');
    }
  );
});
