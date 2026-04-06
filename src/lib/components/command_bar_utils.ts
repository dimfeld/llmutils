import type { SessionData } from '$lib/types/session.js';

export interface NavItem {
  label: string;
  slug: string;
  keywords: string;
}

export const ALL_NAV_ITEMS: NavItem[] = [
  { label: 'Sessions', slug: 'sessions', keywords: 'sessions agents running' },
  { label: 'Active Work', slug: 'active', keywords: 'active work dashboard attention' },
  { label: 'Pull Requests', slug: 'prs', keywords: 'pull requests prs github' },
  { label: 'Plans', slug: 'plans', keywords: 'plans list browse' },
  { label: 'Settings', slug: 'settings', keywords: 'settings configuration' },
];

export function getNavigationItems(projectId: string, searchQuery: string): NavItem[] {
  let items = ALL_NAV_ITEMS;
  if (projectId === 'all') {
    items = items.filter((item) => item.slug !== 'settings');
  }

  const q = searchQuery.trim().toLowerCase();
  if (!q) return items;

  return items.filter((item) => item.label.toLowerCase().includes(q) || item.keywords.includes(q));
}

export function filterSessions(
  sessions: Iterable<SessionData>,
  searchQuery: string,
  projectId: string,
  allProjects: boolean
): SessionData[] {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return [];

  const results: SessionData[] = [];
  for (const session of sessions) {
    if (session.status === 'offline') continue;

    if (!allProjects && projectId !== 'all' && session.projectId !== Number(projectId)) {
      continue;
    }

    const planTitle = session.sessionInfo.planTitle?.toLowerCase() ?? '';
    const command = session.sessionInfo.command?.toLowerCase() ?? '';
    const planId = session.sessionInfo.planId ? String(session.sessionInfo.planId) : '';

    if (planTitle.includes(q) || command.includes(q) || planId === q) {
      results.push(session);
    }
  }

  return results;
}

export function formatStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function navigateToSelection(
  url: string,
  close: () => void,
  navigate: (url: string) => Promise<unknown> | unknown
): Promise<void> {
  close();
  await navigate(url);
}
