import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

import PrsLayout from './+layout.svelte';

const mockGetProjectPrs = vi.fn();

vi.mock('$app/navigation', () => ({
  afterNavigate: vi.fn(),
}));

vi.mock('$app/state', () => ({
  page: {
    params: {},
  },
}));

vi.mock('$lib/components/PrList.svelte', () => ({
  default: () => '',
}));

vi.mock('$lib/remote/project_prs.remote.js', () => ({
  getProjectPrs: (...args: unknown[]) => mockGetProjectPrs(...args),
  refreshProjectPrs: vi.fn(),
  fullRefreshProjectPrs: vi.fn(),
}));

describe('projects/[projectId]/prs/+layout.svelte', () => {
  test('renders the full refresh action in the empty-state CTA when a token is configured', async () => {
    mockGetProjectPrs.mockResolvedValue({
      authored: [],
      reviewing: [],
      username: null,
      hasData: false,
      tokenConfigured: true,
      webhookConfigured: true,
    });

    const { body } = await render(PrsLayout, {
      props: {
        children: () => '',
        params: {
          projectId: '12',
        },
      },
    });

    expect(body).toContain('Fetch Pull Requests');
    expect(body).toContain('Full Refresh');
    expect(body).toContain('aria-label="Fully refresh pull requests from GitHub"');
  });
});
