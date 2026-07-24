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
  projectDisplayName: (repoId: string, username?: string) => {
    // Mimic real behavior: strip owner prefix when it matches username
    const parts = repoId.split('/');
    if (parts.length === 2 && username && parts[0] === username) {
      return parts[1];
    }
    return repoId;
  },
  projectUrl: (id: string | number, slug: string) => `/projects/${id}/${slug}`,
  getProjectAbbreviation: (name: string) => name.slice(0, 2).toUpperCase(),
  getProjectColor: (name: string) => {
    // Return different colors for different names so tests can distinguish
    if (name === 'test-repo') return '#3498db';
    if (name === 'llmutils') return '#e74c3c';
    return '#2ecc71';
  },
  getContrastTextColor: () => 'white',
  PROJECT_COLOR_PALETTE: ['#3498db', '#e74c3c', '#2ecc71'],
  getSidebarOrderedProjects: (projects: any[]) => projects,
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
  test('always renders the compact project rail with avatar links and a featured divider', () => {
    pageState.url = new URL('http://localhost/projects/1/sessions');

    const { body } = render(ProjectSidebar, {
      props: {
        projects: [
          makeProject({ id: 1, repository_id: 'featured-project', featured: true }),
          makeProject({
            id: 2,
            repository_id: 'hidden-project',
            featured: false,
            abbreviation: 'HP',
            color: '#e74c3c',
          }),
        ],
        selectedProjectId: '1',
        currentUsername: 'alice',
      },
    });

    expect(body).toContain('class="flex w-12 shrink-0 flex-col');
    expect(body).not.toContain('Expand sidebar');
    expect(body).toContain('href="/projects/all/sessions"');
    expect(body).toContain('>ALL<');
    expect(body).toContain('href="/projects/1/sessions"');
    expect(body).toContain('>FE<');
    expect(body).toContain('href="/projects/2/sessions"');
    expect(body).toContain('>HP<');
    expect(body).toContain('background-color: #e74c3c;');
    expect(body).toContain('aria-label="hidden-project"');
    expect(body).toContain('class="my-1 w-6 border-t border-border"');
    expect(body).not.toContain('>Other Projects<');
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

  test('collapsed avatar uses display name (owner-stripped) for self-owned repos', () => {
    pageState.url = new URL('http://localhost/projects/1/sessions');
    const { body } = render(ProjectSidebar, {
      props: {
        projects: [makeProject({ id: 1, repository_id: 'alice/llmutils', featured: true })],
        selectedProjectId: '1',
        currentUsername: 'alice',
      },
    });

    // projectDisplayName('alice/llmutils', 'alice') returns 'llmutils'
    // getProjectAbbreviation('llmutils') returns 'LL' (first two chars)
    // NOT 'AL' which would result from projectAvatarName('alice/llmutils')
    expect(body).toContain('>LL<');
    expect(body).not.toContain('>AL<');
    // Color should be based on 'llmutils' display name, not 'alice/llmutils'
    expect(body).toContain('background-color: #e74c3c;');
  });
});
