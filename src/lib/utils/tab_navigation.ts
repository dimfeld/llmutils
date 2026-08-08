/**
 * Tab slug order for the project nav bar. Must stay in sync with `TabNav.svelte`'s
 * `baseTabs` array (same order) and with `TAB_DIGIT_MAX` in `keyboard_shortcuts.ts`
 * (must equal `baseTabSlugs.length` so Ctrl+N reaches every tab and no further).
 */
export const baseTabSlugs = ['sessions', 'active', 'prs', 'activity', 'inbox', 'plans'] as const;
export const projectTabSlugs = [...baseTabSlugs, 'settings'] as const;

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
  if (
    currentTab === 'settings' ||
    !baseTabSlugs.includes(currentTab as (typeof baseTabSlugs)[number])
  ) {
    return 'sessions';
  }
  return currentTab;
}
