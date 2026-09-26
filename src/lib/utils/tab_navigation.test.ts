import { describe, expect, test } from 'vitest';
import {
  BASE_TABS,
  PROJECT_TABS,
  baseTabSlugs,
  projectTabSlugs,
  resolvePreservedTabForProjectSwitch,
  resolveTabSlugForIndex,
} from './tab_navigation.js';

describe('tab_navigation', () => {
  test('BASE_TABS has Plans after Active Work', () => {
    expect(BASE_TABS.map((t) => t.slug)).toEqual([
      'sessions',
      'active',
      'plans',
      'prs',
      'activity',
      'inbox',
    ]);
  });

  test('PROJECT_TABS appends Settings after the base tabs', () => {
    expect(PROJECT_TABS).toEqual([...BASE_TABS, { label: 'Settings', slug: 'settings' }]);
  });

  test('baseTabSlugs is derived from BASE_TABS', () => {
    expect(baseTabSlugs).toEqual(BASE_TABS.map((t) => t.slug));
  });

  test('projectTabSlugs is derived from PROJECT_TABS', () => {
    expect(projectTabSlugs).toEqual(PROJECT_TABS.map((t) => t.slug));
  });

  describe('resolveTabSlugForIndex', () => {
    test('Ctrl+3 resolves to plans for a specific project', () => {
      expect(resolveTabSlugForIndex('1', 3)).toBe('plans');
    });

    test('Ctrl+3 resolves to plans for the all-projects context', () => {
      expect(resolveTabSlugForIndex('all', 3)).toBe('plans');
    });

    test('Ctrl+6 resolves to the Inbox tab', () => {
      expect(resolveTabSlugForIndex('1', 6)).toBe('inbox');
    });

    test('Ctrl+7 resolves to settings for a specific project', () => {
      expect(resolveTabSlugForIndex('1', 7)).toBe('settings');
    });

    test('Ctrl+7 is out of range for the all-projects context (no settings tab)', () => {
      expect(resolveTabSlugForIndex('all', 7)).toBeUndefined();
    });

    test('Ctrl+8 is out of range even for a specific project', () => {
      expect(resolveTabSlugForIndex('1', 8)).toBeUndefined();
    });

    test('index 0 is out of range', () => {
      expect(resolveTabSlugForIndex('1', 0)).toBeUndefined();
    });
  });

  describe('resolvePreservedTabForProjectSwitch', () => {
    test('preserves the Inbox tab across a project switch', () => {
      expect(resolvePreservedTabForProjectSwitch('inbox')).toBe('inbox');
    });

    test('preserves other base tabs across a project switch', () => {
      for (const slug of baseTabSlugs) {
        expect(resolvePreservedTabForProjectSwitch(slug)).toBe(slug);
      }
    });

    test('falls back to sessions from settings, which is not a shared base tab', () => {
      expect(resolvePreservedTabForProjectSwitch('settings')).toBe('sessions');
    });

    test('falls back to sessions for an unrecognized tab', () => {
      expect(resolvePreservedTabForProjectSwitch('unknown')).toBe('sessions');
    });
  });
});
