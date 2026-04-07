import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';

import type { PrReviewThreadDetail } from '$tim/db/pr_status.js';
import PrReviewThreadList from './PrReviewThreadList.svelte';

function makeThread(
  overrides: Partial<PrReviewThreadDetail['thread']> = {},
  commentOverrides: Partial<PrReviewThreadDetail['comments'][number]> = {}
): PrReviewThreadDetail {
  const threadId = overrides.id ?? 1;
  return {
    thread: {
      id: threadId,
      pr_status_id: 1,
      thread_id: `thread-${threadId}`,
      path: 'src/example.ts',
      line: 10,
      original_line: 10,
      original_start_line: null,
      start_line: null,
      diff_side: 'RIGHT',
      start_diff_side: null,
      is_resolved: 0,
      is_outdated: 0,
      subject_type: 'LINE',
      ...overrides,
    },
    comments: [
      {
        id: threadId,
        review_thread_id: threadId,
        comment_id: `comment-${threadId}`,
        database_id: 5000 + threadId,
        author: 'reviewer',
        body: 'Please update this.',
        diff_hunk: '@@ -1,1 +1,1 @@',
        state: 'COMMENTED',
        created_at: '2026-03-18T10:05:00.000Z',
        ...commentOverrides,
      },
    ],
  };
}

describe('PrReviewThreadList', () => {
  test('sorts threads by file path and line number and renders GitHub discussion links', async () => {
    const { body } = await render(PrReviewThreadList, {
      props: {
        prUrl: 'https://github.com/owner/repo/pull/42',
        planUuid: 'plan-uuid-1',
        threads: [
          makeThread({ id: 2, path: 'src/z.ts', line: 2 }),
          makeThread({ id: 1, path: 'src/a.ts', line: 1 }, { database_id: 9001 }),
        ],
      },
    });

    expect(body.indexOf('src/a.ts:1')).toBeLessThan(body.indexOf('src/z.ts:2'));
    expect(body).toContain('href="https://github.com/owner/repo/pull/42#discussion_r9001"');
    expect(body).toContain('Copy');
  });

  test('renders unresolved threads expanded and resolved threads collapsed by default', async () => {
    const { body } = await render(PrReviewThreadList, {
      props: {
        prUrl: 'https://github.com/owner/repo/pull/42',
        planUuid: 'plan-uuid-1',
        threads: [
          makeThread({ id: 1, is_resolved: 0 }),
          makeThread({ id: 2, is_resolved: 1, path: 'src/b.ts' }),
        ],
      },
    });

    expect(body.match(/<details open/g) ?? []).toHaveLength(1);
    expect(body).toContain('Resolved');
  });

  test('renders unresolved thread actions only for unresolved threads', async () => {
    const { body } = await render(PrReviewThreadList, {
      props: {
        prUrl: 'https://github.com/owner/repo/pull/42',
        planUuid: 'plan-uuid-1',
        threads: [
          makeThread({ id: 1, is_resolved: 0 }),
          makeThread({ id: 2, is_resolved: 1, path: 'src/resolved.ts' }),
        ],
      },
    });

    expect(body).toContain('Convert to Task');
    expect(body).toContain('>Resolve<');
    expect(body).toContain('>Reply<');
    expect(body.match(/Convert to Task/g) ?? []).toHaveLength(1);
    expect(body.match(/>Resolve</g) ?? []).toHaveLength(1);
    expect(body.match(/>Reply</g) ?? []).toHaveLength(1);
  });

  test('does not render unresolved thread actions when all threads are resolved', async () => {
    const { body } = await render(PrReviewThreadList, {
      props: {
        prUrl: 'https://github.com/owner/repo/pull/42',
        planUuid: 'plan-uuid-1',
        threads: [
          makeThread({ id: 1, is_resolved: 1 }),
          makeThread({ id: 2, is_resolved: 1, path: 'src/also-resolved.ts' }),
        ],
      },
    });

    expect(body).not.toContain('Convert to Task');
    expect(body).not.toContain('>Resolve<');
    expect(body).not.toContain('>Reply<');
    expect(body).not.toContain('Reply to review thread');
  });

  test('does not render the reply form by default', async () => {
    const { body } = await render(PrReviewThreadList, {
      props: {
        prUrl: 'https://github.com/owner/repo/pull/42',
        planUuid: 'plan-uuid-1',
        threads: [makeThread({ id: 1, is_resolved: 0 })],
      },
    });

    expect(body).not.toContain('<textarea');
    expect(body).not.toContain('Send');
  });
});
