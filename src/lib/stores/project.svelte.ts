import type { Cookies } from '@sveltejs/kit';
import type { ProjectWithMetadata } from '$lib/server/db_queries.js';

const COOKIE_NAME = 'tim_last_project';

export function setLastProjectId(cookies: Cookies, id: number | string): void {
  try {
    cookies.set(COOKIE_NAME, String(id), {
      path: '/',
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
    });
  } catch (e) {
    // sometimes we call this from a layout load function but the page may have redirected
    if ((e as Error).message.includes('after the response has been')) {
      return;
    }
    throw e;
  }
}

export function getLastProjectId(cookies: Cookies): string | null {
  return cookies.get(COOKIE_NAME) ?? null;
}

export function projectUrl(projectId: number | string, tab: string): string {
  return `/projects/${projectId}/${tab}`;
}

/**
 * Returns projects in sidebar display order: featured first, then unfeatured,
 * both filtered to only include projects with at least one plan.
 * Matches the ordering used by ProjectSidebar.
 */
export function getSidebarOrderedProjects(projects: ProjectWithMetadata[]): ProjectWithMetadata[] {
  const featured = projects.filter((p) => p.featured && p.planCount > 0);
  const unfeatured = projects.filter((p) => !p.featured && p.planCount > 0);
  return [...featured, ...unfeatured];
}

export function projectAvatarName(repositoryId: string | null): string {
  if (!repositoryId) return 'Unknown';

  const parts = repositoryId.split('__').filter(Boolean);
  if (parts.length === 0) return 'Unknown';

  const nameParts = parts.slice(-2);
  return nameParts.join('/');
}

/** Predefined palette of visually distinct colors for project avatars. */
export const PROJECT_COLOR_PALETTE = [
  '#e74c3c', // red
  '#e67e22', // orange
  '#f1c40f', // yellow
  '#2ecc71', // green
  '#1abc9c', // teal
  '#3498db', // blue
  '#2980b9', // dark blue
  '#9b59b6', // purple
  '#8e44ad', // dark purple
  '#e84393', // pink
  '#00cec9', // cyan
  '#6c5ce7', // indigo
] as const;

/**
 * Generate a short abbreviation from a project display name.
 * - Splits on spaces, dashes, underscores, dots, and slashes.
 * - Takes the first letter of the first two words, uppercased.
 * - If only one word, takes the first two characters.
 */
export function getProjectAbbreviation(displayName: string): string {
  const words = displayName.split(/[\s\-_./]+/).filter((w) => w.length > 0);
  if (words.length === 0) return '??';
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Deterministic color assignment from the palette based on display name hash.
 * Returns a hex color string.
 */
export function getProjectColor(displayName: string): string {
  let hash = 0;
  for (let i = 0; i < displayName.length; i++) {
    hash = (hash * 31 + displayName.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % PROJECT_COLOR_PALETTE.length;
  return PROJECT_COLOR_PALETTE[index];
}

/**
 * Returns 'white' or 'black' depending on which has better contrast against the given hex color.
 * Uses relative luminance calculation per WCAG 2.0.
 */
export function getContrastTextColor(hexColor: string): string {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;

  // sRGB to linear
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

  return luminance > 0.179 ? 'black' : 'white';
}

export function projectDisplayName(
  repositoryId: string | null,
  currentUsername?: string | null
): string {
  const nameParts = projectAvatarName(repositoryId).split('/').filter(Boolean);
  if (nameParts.length === 2 && currentUsername && nameParts[0] === currentUsername) {
    return nameParts[1];
  }

  return nameParts.join('/');
}
