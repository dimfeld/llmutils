import { describe, expect, test } from 'vitest';

import { load } from './+page.server.js';

describe('projects/[projectId]/plans/new/+page.server', () => {
  test('loads numeric project context for concrete projects', async () => {
    await expect(
      load({
        parent: async () => ({ projectId: '42' }),
      } as never)
    ).resolves.toEqual({
      numericProjectId: 42,
    });
  });

  test('redirects all-project creation back to the aggregate plans view', async () => {
    await expect(
      load({
        parent: async () => ({ projectId: 'all' }),
      } as never)
    ).rejects.toMatchObject({
      status: 302,
      location: '/projects/all/plans',
    });
  });

  test('redirects invalid project ids back to the aggregate plans view', async () => {
    await expect(
      load({
        parent: async () => ({ projectId: 'not-a-number' }),
      } as never)
    ).rejects.toMatchObject({
      status: 302,
      location: '/projects/all/plans',
    });
  });
});
