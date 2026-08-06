import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';

import ActivityPage from './+page.svelte';

describe('activity page CI fix jobs', () => {
  test('labels ci-fix jobs and prefers their pull request target', async () => {
    const { body } = await render(ActivityPage, {
      props: {
        data: {
          currentUsername: 'owner',
          projects: [{ id: 7, repository_id: 'owner__repo' }],
          activity: [
            {
              id: 1,
              project_id: 7,
              job_type: 'ci-fix',
              plan_id: 42,
              plan_uuid: 'plan-42',
              plan_title: 'Repair CI',
              pr_url: 'https://github.com/owner/repo/pull/42',
              pr_number: 42,
              workspace_path: '/tmp/workspace',
              git_remote: null,
              status: 'completed',
              started_at: '2026-08-06T10:00:00.000Z',
              finished_at: '2026-08-06T10:05:00.000Z',
              created_at: '2026-08-06T10:00:00.000Z',
              updated_at: '2026-08-06T10:05:00.000Z',
              build_sha: null,
              build_time: null,
              binary_path: null,
              outputHref: '/projects/7/prs/42',
              outputExternal: false,
            },
          ],
        },
      } as never,
    });

    expect(body).toContain('Fix CI');
    expect(body).toMatch(/>\s*Fix CI\s*<\/td>/);
    expect(body).not.toContain('>ci-fix</td>');
    expect(body).toContain('PR #42');
    expect(body).toContain('Plan #42: Repair CI');
  });
});
