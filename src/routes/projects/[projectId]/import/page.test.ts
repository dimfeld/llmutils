import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
}));

vi.mock('$app/state', () => ({
  page: {
    params: { projectId: '1' },
  },
}));

vi.mock('$lib/remote/issue_import.remote.js', () => ({
  fetchIssueForImport: vi.fn(),
  importIssue: vi.fn(),
}));

import ImportPage from './+page.svelte';

describe('import page', () => {
  test('renders a paste from clipboard button next to the identifier field', () => {
    const { body } = render(ImportPage, {
      props: {
        data: {
          displayName: 'Example Project',
          trackerType: 'linear',
          supportsHierarchical: true,
          numericProjectId: 1,
        },
        params: {
          projectId: '1',
        },
      },
    });

    expect(body).toContain('aria-label="Paste from clipboard"');
    expect(body).toContain('title="Paste from clipboard"');
  });
});
