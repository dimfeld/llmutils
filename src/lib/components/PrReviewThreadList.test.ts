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

function makeLongHunk(focusLine = 15, totalLines = 30): string {
  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;

  for (let line = 1; line <= totalLines; line += 1) {
    if (line === focusLine) {
      body.push(`-line${line}-old`);
      body.push(`+line${line}-new`);
      oldCount += 1;
      newCount += 1;
      continue;
    }

    body.push(` line${line}`);
    oldCount += 1;
    newCount += 1;
  }

  return `@@ -1,${oldCount} +1,${newCount} @@\n${body.join('\n')}`;
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
    expect(body).toContain('Copy with Diff');
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

  test('renders expand controls and opens only threads where the current user commented', async () => {
    const { body } = await render(PrReviewThreadList, {
      props: {
        prUrl: 'https://github.com/owner/repo/pull/42',
        planUuid: 'plan-uuid-1',
        currentUsername: 'alice',
        expandMode: 'mine',
        threads: [
          makeThread({ id: 1, is_resolved: 1 }, { author: 'alice' }),
          makeThread({ id: 2, is_resolved: 1, path: 'src/b.ts' }, { author: 'bob' }),
        ],
      },
    });

    expect(body).toContain('Expand all');
    expect(body).toContain('Collapse all');
    expect(body).toContain('My comments');
    expect(body).toContain('Your Thread');
    expect(body.match(/<details open/g) ?? []).toHaveLength(1);
  });

  test('renders a generic badge when the current user commented but was not first', async () => {
    const thread: PrReviewThreadDetail = {
      thread: {
        id: 1,
        pr_status_id: 1,
        thread_id: 'thread-1',
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
      },
      comments: [
        {
          id: 1,
          review_thread_id: 1,
          comment_id: 'c1',
          database_id: 5001,
          author: 'bob',
          body: 'First comment from Bob.',
          diff_hunk: '@@ -1,1 +1,1 @@',
          state: 'COMMENTED',
          created_at: '2026-03-18T10:00:00.000Z',
        },
        {
          id: 2,
          review_thread_id: 1,
          comment_id: 'c2',
          database_id: 5002,
          author: 'alice',
          body: 'Reply from Alice.',
          diff_hunk: null,
          state: 'COMMENTED',
          created_at: '2026-03-18T10:05:00.000Z',
        },
      ],
    };

    const { body } = await render(PrReviewThreadList, {
      props: {
        prUrl: 'https://github.com/owner/repo/pull/42',
        planUuid: 'plan-uuid-1',
        currentUsername: 'alice',
        expandMode: 'mine',
        threads: [thread],
      },
    });

    expect(body).toContain('You commented');
    expect(body).not.toContain('Your Thread');
    expect(body.match(/<details open/g) ?? []).toHaveLength(1);
  });

  test('respects explicit expand modes', async () => {
    const baseProps = {
      prUrl: 'https://github.com/owner/repo/pull/42',
      planUuid: 'plan-uuid-1',
      currentUsername: 'alice',
      threads: [
        makeThread({ id: 1, is_resolved: 1 }, { author: 'alice' }),
        makeThread({ id: 2, is_resolved: 1, path: 'src/b.ts' }, { author: 'bob' }),
      ],
    };

    const expanded = await render(PrReviewThreadList, {
      props: {
        ...baseProps,
        expandMode: 'expanded',
      },
    });
    expect(expanded.body.match(/<details open/g) ?? []).toHaveLength(2);

    const collapsed = await render(PrReviewThreadList, {
      props: {
        ...baseProps,
        expandMode: 'collapsed',
      },
    });
    expect(collapsed.body.match(/<details open/g) ?? []).toHaveLength(0);
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

  test('renders review comment bodies with the plan markdown styler', async () => {
    const { body } = await render(PrReviewThreadList, {
      props: {
        prUrl: 'https://github.com/owner/repo/pull/42',
        planUuid: 'plan-uuid-1',
        threads: [
          makeThread(
            {},
            {
              body: '# Heading\n\nUse `foo()` and **bold** text',
            }
          ),
        ],
      },
    });

    expect(body).toContain('<span class="plan-heading"># Heading</span>');
    expect(body).toContain('<span class="plan-inline-code">`foo()`</span>');
    expect(body).toContain('<span class="plan-bold">**bold**</span>');
  });

  test('truncates long diff hunks by default and offers a toggle to show the full hunk', async () => {
    const { body } = await render(PrReviewThreadList, {
      props: {
        prUrl: 'https://github.com/owner/repo/pull/42',
        planUuid: 'plan-uuid-1',
        threads: [
          makeThread(
            {
              line: 15,
              original_line: 15,
              diff_side: 'RIGHT',
            },
            {
              diff_hunk: makeLongHunk(),
            }
          ),
        ],
      },
    });

    expect(body).toContain('Showing 10 lines of context');
    expect(body).toContain('Show full hunk');
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

  test('renders outdated badge on outdated threads', async () => {
    const { body } = await render(PrReviewThreadList, {
      props: {
        prUrl: 'https://github.com/owner/repo/pull/42',
        planUuid: 'plan-uuid-1',
        threads: [makeThread({ id: 1, is_outdated: 1, is_resolved: 0 })],
      },
    });

    expect(body).toContain('Outdated');
  });

  test('renders path without line number when line is null', async () => {
    const { body } = await render(PrReviewThreadList, {
      props: {
        prUrl: 'https://github.com/owner/repo/pull/42',
        planUuid: 'plan-uuid-1',
        threads: [
          makeThread({
            id: 1,
            path: 'src/no-line.ts',
            line: null,
            original_line: null,
            start_line: null,
            original_start_line: null,
          }),
        ],
      },
    });

    expect(body).toContain('src/no-line.ts');
    expect(body).not.toContain('src/no-line.ts:');
  });

  test('renders multiple comments within a single thread', async () => {
    const thread: PrReviewThreadDetail = {
      thread: {
        id: 1,
        pr_status_id: 1,
        thread_id: 'thread-multi',
        path: 'src/multi.ts',
        line: 5,
        original_line: 5,
        original_start_line: null,
        start_line: null,
        diff_side: 'RIGHT',
        start_diff_side: null,
        is_resolved: 0,
        is_outdated: 0,
        subject_type: 'LINE',
      },
      comments: [
        {
          id: 1,
          review_thread_id: 1,
          comment_id: 'c1',
          database_id: 1001,
          author: 'alice',
          body: 'First comment from Alice.',
          diff_hunk: '@@ -1,1 +1,1 @@',
          state: 'COMMENTED',
          created_at: '2026-03-18T10:00:00Z',
        },
        {
          id: 2,
          review_thread_id: 1,
          comment_id: 'c2',
          database_id: 1002,
          author: 'bob',
          body: 'Reply from Bob.',
          diff_hunk: null,
          state: 'COMMENTED',
          created_at: '2026-03-18T10:05:00Z',
        },
      ],
    };

    const { body } = await render(PrReviewThreadList, {
      props: {
        prUrl: 'https://github.com/owner/repo/pull/42',
        planUuid: 'plan-uuid-1',
        threads: [thread],
      },
    });

    expect(body).toContain('alice');
    expect(body).toContain('First comment from Alice.');
    expect(body).toContain('bob');
    expect(body).toContain('Reply from Bob.');
    expect(body).toContain('2 comments');
  });

  test('renders empty list when no threads provided', async () => {
    const { body } = await render(PrReviewThreadList, {
      props: {
        prUrl: 'https://github.com/owner/repo/pull/42',
        planUuid: 'plan-uuid-1',
        threads: [],
      },
    });

    expect(body).not.toContain('Convert to Task');
    expect(body).not.toContain('>Resolve<');
    expect(body).not.toContain('>Reply<');
    expect(body).not.toContain('<details');
  });
});
