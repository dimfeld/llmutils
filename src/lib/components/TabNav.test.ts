import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

vi.mock('$app/state', () => ({
  page: {
    url: new URL('http://localhost/projects/1/sessions'),
    params: { projectId: '1' },
  },
}));

vi.mock('$lib/stores/project.svelte.js', () => ({
  projectUrl: (id: string | number, slug: string) => `/projects/${id}/${slug}`,
}));

import TabNav from './TabNav.svelte';

describe('TabNav', () => {
  test('renders the settings tab for project-specific navigation', () => {
    const { body } = render(TabNav, {
      props: {
        projectId: '1',
      },
    });

    expect(body).toContain('href="/projects/1/settings"');
  });

  test('does not render the settings tab for the all-projects view', () => {
    const { body } = render(TabNav, {
      props: {
        projectId: 'all',
      },
    });

    expect(body).not.toContain('href="/projects/all/settings"');
  });

  test('always renders the standard project tabs', () => {
    const { body } = render(TabNav, {
      props: {
        projectId: '1',
      },
    });

    expect(body).toContain('href="/projects/1/sessions"');
    expect(body).toContain('href="/projects/1/active"');
    expect(body).toContain('href="/projects/1/prs"');
    expect(body).toContain('href="/projects/1/plans"');
  });

  test('renders the Inbox tab between Activity and Plans, matching the layout shortcut slug order', () => {
    const { body } = render(TabNav, {
      props: {
        projectId: '1',
      },
    });

    expect(body).toContain('href="/projects/1/inbox"');
    expect(body).toContain('title="Inbox"');

    const activityIndex = body.indexOf('href="/projects/1/activity"');
    const inboxIndex = body.indexOf('href="/projects/1/inbox"');
    const plansIndex = body.indexOf('href="/projects/1/plans"');
    expect(activityIndex).toBeGreaterThan(-1);
    expect(activityIndex).toBeLessThan(inboxIndex);
    expect(inboxIndex).toBeLessThan(plansIndex);
  });

  test('renders the Inbox tab for the all-projects view', () => {
    const { body } = render(TabNav, {
      props: {
        projectId: 'all',
      },
    });

    expect(body).toContain('href="/projects/all/inbox"');
  });

  test('renders an attention dot on the Sessions tab when requested', () => {
    const { body } = render(TabNav, {
      props: {
        projectId: '1',
        showSessionsAttentionDot: true,
      },
    });

    expect(body).toContain('bg-blue-400');
  });
});
