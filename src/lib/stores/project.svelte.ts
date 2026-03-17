import type { Cookies } from '@sveltejs/kit';

const COOKIE_NAME = 'tim_last_project';

export function setLastProjectId(cookies: Cookies, id: number | string): void {
  cookies.set(COOKIE_NAME, String(id), {
    path: '/',
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
}

export function getLastProjectId(cookies: Cookies): string | null {
  return cookies.get(COOKIE_NAME) ?? null;
}

export function projectUrl(projectId: number | string, tab: string): string {
  return `/projects/${projectId}/${tab}`;
}

export function projectDisplayName(lastGitRoot: string | null): string {
  if (!lastGitRoot) return 'Unknown';
  const parts = lastGitRoot.replace(/\/+$/, '').split('/');
  return parts.slice(-2).join('/');
}
