import type { SessionData } from '$lib/types/session.js';

export interface NavItem {
  label: string;
  slug: string;
  keywords: string;
}

function isGithubIssueLikeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const isGithubHost = url.hostname === 'github.com' || url.hostname.endsWith('.github.com');
    if (!isGithubHost) return false;

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 4) return false;

    return (
      (segments[2] === 'issues' || segments[2] === 'pull' || segments[2] === 'pulls') &&
      /^\d+$/.test(segments[3] ?? '')
    );
  } catch {
    return false;
  }
}

function isLinearIssueLikeUrl(value: string): boolean {
  return /^https:\/\/linear\.app\/[^/]+\/issue\/[A-Za-z][A-Za-z0-9]*-\d+(?:\/[^/]*)?$/i.test(
    value
  );
}

function isImportIdentifierLike(value: string): boolean {
  if (!value || /\s/.test(value)) {
    return false;
  }

  if (isGithubIssueLikeUrl(value) || isLinearIssueLikeUrl(value)) {
    return true;
  }

  return (
    /^([A-Za-z][A-Za-z0-9]*-\d+)$/.test(value) ||
    /^(\d+)$/.test(value) ||
    /^([^/]+)\/([^/#]+)#(\d+)$/.test(value) ||
    /^([^/]+)\/([^/]+)\/(\d+)$/.test(value) ||
    /^([^/]+)\/([^/]+)\/pulls?\/(\d+)$/.test(value) ||
    /-([A-Za-z][A-Za-z0-9]*-\d+)$/i.test(value) ||
    /-(\d+)$/i.test(value)
  );
}

export const ALL_NAV_ITEMS: NavItem[] = [
  { label: 'Sessions', slug: 'sessions', keywords: 'sessions agents running' },
  { label: 'Active Work', slug: 'active', keywords: 'active work dashboard attention' },
  { label: 'Pull Requests', slug: 'prs', keywords: 'pull requests prs github' },
  { label: 'Plans', slug: 'plans', keywords: 'plans list browse' },
  { label: 'Import', slug: 'import', keywords: 'import issue issues tracker clipboard paste' },
  { label: 'Settings', slug: 'settings', keywords: 'settings configuration' },
];

export function getNavigationItems(projectId: string, searchQuery: string): NavItem[] {
  let items = ALL_NAV_ITEMS;
  if (projectId === 'all') {
    items = items.filter(
      (item) => item.slug !== 'settings' && item.slug !== 'import'
    );
  }

  const q = searchQuery.trim().toLowerCase();
  if (!q) return items;

  return items.filter((item) => item.label.toLowerCase().includes(q) || item.keywords.includes(q));
}

export function detectImportIdentifierFromClipboard(text: string): string | null {
  const trimmed = text.trim();
  return isImportIdentifierLike(trimmed) ? trimmed : null;
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
    if (session.status !== 'active') continue;

    if (!allProjects && projectId !== 'all' && session.projectId !== Number(projectId)) {
      continue;
    }

    const planTitle = session.sessionInfo.planTitle?.toLowerCase() ?? '';
    const planId = session.sessionInfo.planId ? String(session.sessionInfo.planId) : '';

    if (planTitle.includes(q) || planId === q) {
      results.push(session);
    }
  }

  return results;
}

export function formatStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
