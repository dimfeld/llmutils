import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

import type { ProjectWithMetadata } from '$lib/server/db_queries.js';

const { pageState } = vi.hoisted(() => ({
  pageState: {
    url: new URL('http://localhost/projects/1/sessions'),
  },
}));

vi.mock('$app/state', () => ({
  page: pageState,
}));

vi.mock('$app/paths', () => ({
  resolve: (path: string) => path,
}));

vi.mock('$lib/stores/project.svelte.js', () => ({
  projectDisplayName: (repoId: string) => repoId,
  projectUrl: (id: string | number, slug: string) => `/projects/${id}/${slug}`,
}));

import ProjectSidebar from './ProjectSidebar.svelte';

function makeProject(overrides: Partial<ProjectWithMetadata> = {}): ProjectWithMetadata {
  return {
    id: 1,
    repository_id: 'test-repo',
    remote_url: null,
    last_git_root: null,
    external_config_path: null,
    external_tasks_dir: null,
    remote_label: null,
    highest_plan_id: 0,
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
    planCount: 5,
    activePlanCount: 2,
    statusCounts: {
      pending: 1,
      in_progress: 1,
      needs_review: 0,
      done: 2,
      cancelled: 1,
      deferred: 0,
    },
    featured: true,
    ...overrides,
  };
}

describe('ProjectSidebar', () => {
  test('renders featured projects in the main list and unfeatured projects in the other-projects section', () => {
    pageState.url = new URL('http://localhost/projects/1/sessions');

    const { body } = render(ProjectSidebar, {
      props: {
        projects: [
          makeProject({ id: 1, repository_id: 'featured-project', featured: true }),
          makeProject({ id: 2, repository_id: 'hidden-project', featured: false }),
        ],
        selectedProjectId: '1',
        currentUsername: 'alice',
      },
    });

    expect(body).toContain('>Other Projects<');
    expect(body).toContain('href="/projects/1/sessions"');
    expect(body).toContain('>featured-project<');
    expect(body).toContain('href="/projects/2/sessions"');
    expect(body).toContain('>hidden-project<');
    expect(body).toContain('<details class="mt-2">');
  });

  test('hides the other-projects section when all projects are featured', () => {
    pageState.url = new URL('http://localhost/projects/1/sessions');

    const { body } = render(ProjectSidebar, {
      props: {
        projects: [makeProject({ id: 1, repository_id: 'featured-project', featured: true })],
        selectedProjectId: '1',
        currentUsername: 'alice',
      },
    });

    expect(body).not.toContain('>Other Projects<');
    expect(body).not.toContain('<details');
  });

  test('uses the sessions tab for the all-projects link when the current tab is settings', () => {
    pageState.url = new URL('http://localhost/projects/1/settings');

    const { body } = render(ProjectSidebar, {
      props: {
        projects: [makeProject({ id: 1, repository_id: 'featured-project', featured: true })],
        selectedProjectId: '1',
        currentUsername: 'alice',
      },
    });

    expect(body).toContain('href="/projects/all/sessions"');
    expect(body).not.toContain('href="/projects/all/settings"');
  });
});
