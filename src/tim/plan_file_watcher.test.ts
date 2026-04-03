import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { stripPlanFrontmatter, watchPlanFile } from './plan_file_watcher.js';

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('watchPlanFile', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'tim-plan-file-watcher-test-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  test('emits initial and updated plan content with frontmatter stripped', async () => {
    const planPath = path.join(tempDir, '302.plan.md');
    await writeFile(
      planPath,
      ['---', 'id: 302', 'title: Example', '---', '', '# Body', '', 'Current text'].join('\n')
    );

    const contents: string[] = [];
    const watcher = watchPlanFile(planPath, (content) => {
      contents.push(content);
    });

    await waitFor(() => contents.length === 1);
    expect(contents[0]).toBe('# Body\n\nCurrent text');

    await writeFile(
      planPath,
      ['---', 'id: 302', 'title: Example', '---', '', '# Body', '', 'Updated text'].join('\n')
    );

    await waitFor(() => contents.length === 2);
    expect(contents[1]).toBe('# Body\n\nUpdated text');

    watcher.close();
  });

  test('debounces rapid file changes into one update', async () => {
    const planPath = path.join(tempDir, '302.plan.md');
    await writeFile(planPath, ['---', 'id: 302', '---', '', 'first'].join('\n'));

    const contents: string[] = [];
    const watcher = watchPlanFile(planPath, (content) => {
      contents.push(content);
    });

    await waitFor(() => contents.length === 1);

    await writeFile(planPath, ['---', 'id: 302', '---', '', 'second'].join('\n'));
    await writeFile(planPath, ['---', 'id: 302', '---', '', 'third'].join('\n'));
    await writeFile(planPath, ['---', 'id: 302', '---', '', 'final'].join('\n'));

    await waitFor(() => contents.length === 2);
    expect(contents).toEqual(['first', 'final']);

    watcher.close();
  });

  test('stops emitting updates after close', async () => {
    const planPath = path.join(tempDir, '302.plan.md');
    await writeFile(planPath, ['---', 'id: 302', '---', '', 'first'].join('\n'));

    const contents: string[] = [];
    const watcher = watchPlanFile(planPath, (content) => {
      contents.push(content);
    });

    await waitFor(() => contents.length === 1);
    watcher.close();

    await writeFile(planPath, ['---', 'id: 302', '---', '', 'second'].join('\n'));
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(contents).toEqual(['first']);
  });

  test('returns trimmed content when frontmatter is missing or incomplete', () => {
    expect(stripPlanFrontmatter('\n# Body\n\nText\n')).toBe('# Body\n\nText');
    expect(stripPlanFrontmatter(['---', 'id: 302', 'title: Missing end'].join('\n'))).toBe(
      '---\nid: 302\ntitle: Missing end'
    );
  });

  test('returns an inert watcher when the plan file does not exist yet', async () => {
    const planPath = path.join(tempDir, 'missing.plan.md');
    const contents: string[] = [];

    const watcher = watchPlanFile(planPath, (content) => {
      contents.push(content);
    });

    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(contents).toEqual([]);
    expect(() => watcher.close()).not.toThrow();
  });
});
