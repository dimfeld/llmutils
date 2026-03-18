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

export function projectDisplayName(
  repositoryId: string | null,
  currentUsername?: string | null
): string {
  if (!repositoryId) return 'Unknown';

  const parts = repositoryId.split('__').filter(Boolean);
  if (parts.length === 0) return 'Unknown';

  const nameParts = parts.slice(-2);
  if (nameParts.length === 2 && currentUsername && nameParts[0] === currentUsername) {
    return nameParts[1];
  }

  return nameParts.join('/');
}
