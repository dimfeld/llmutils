export interface TabDescriptor {
  label: string;
  slug: string;
}

export const BASE_TABS: readonly TabDescriptor[] = [
  { label: 'Sessions', slug: 'sessions' },
  { label: 'Active Work', slug: 'active' },
  { label: 'Pull Requests', slug: 'prs' },
  { label: 'Activity', slug: 'activity' },
  { label: 'Inbox', slug: 'inbox' },
  { label: 'Plans', slug: 'plans' },
] as const;

const SETTINGS_TAB: TabDescriptor = { label: 'Settings', slug: 'settings' };

export const PROJECT_TABS: readonly TabDescriptor[] = [...BASE_TABS, SETTINGS_TAB];

export const baseTabSlugs = BASE_TABS.map((t) => t.slug);
export const projectTabSlugs = PROJECT_TABS.map((t) => t.slug);

/**
 * Resolves the tab slug that Ctrl+`tabIndex` should navigate to for the given project
 * context. Returns undefined when the index is out of range, or when it would resolve
 * to Settings while viewing the all-projects context (Settings isn't valid there).
 */
export function resolveTabSlugForIndex(projectId: string, tabIndex: number): string | undefined {
  const tabSlugs = projectId === 'all' ? baseTabSlugs : projectTabSlugs;
  const slug = tabSlugs[tabIndex - 1];
  if (slug && !(projectId === 'all' && slug === 'settings')) {
    return slug;
  }
  return undefined;
}

/**
 * Resolves which tab should remain active after a Ctrl+Shift+N project switch.
 * Falls back to 'sessions' when the current tab isn't a shared base tab (e.g. Settings,
 * which doesn't exist on other projects).
 */
export function resolvePreservedTabForProjectSwitch(currentTab: string): string {
  if (currentTab === 'settings' || !baseTabSlugs.includes(currentTab)) {
    return 'sessions';
  }
  return currentTab;
}
