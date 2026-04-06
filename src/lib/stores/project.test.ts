import { describe, expect, test } from 'vitest';

import {
  getProjectAbbreviation,
  getContrastTextColor,
  getProjectColor,
  PROJECT_COLOR_PALETTE,
  projectAvatarName,
  projectDisplayName,
} from './project.svelte.js';

describe('projectDisplayName', () => {
  test('uses the last two repository_id segments', () => {
    expect(projectDisplayName('github.com__deviceflow__code', 'dimfeld')).toBe('deviceflow/code');
  });

  test('drops the first segment when it matches the current username', () => {
    expect(projectDisplayName('github.com__dimfeld__llmutils', 'dimfeld')).toBe('llmutils');
  });

  test('keeps both segments when the username does not match', () => {
    expect(projectDisplayName('github.com__dimfeld__llmutils', 'other-user')).toBe(
      'dimfeld/llmutils'
    );
  });

  test('falls back to the single trailing segment when only one segment is available', () => {
    expect(projectDisplayName('external-tasks', 'dimfeld')).toBe('external-tasks');
  });

  test('returns Unknown when repository_id is missing', () => {
    expect(projectDisplayName(null, 'dimfeld')).toBe('Unknown');
  });
});

describe('projectAvatarName', () => {
  test('preserves owner and repo from repository_id', () => {
    expect(projectAvatarName('github.com__dimfeld__llmutils')).toBe('dimfeld/llmutils');
  });

  test('falls back to the trailing segment for single-part identifiers', () => {
    expect(projectAvatarName('external-tasks')).toBe('external-tasks');
  });

  test('returns Unknown when repository_id is missing', () => {
    expect(projectAvatarName(null)).toBe('Unknown');
  });

  test('display name produces different abbreviation than avatar name for self-owned repos', () => {
    const repositoryId = 'github.com__dimfeld__llmutils';
    const avatarName = projectAvatarName(repositoryId);
    const selfOwnedDisplay = projectDisplayName(repositoryId, 'dimfeld');
    const otherUserDisplay = projectDisplayName(repositoryId, 'other-user');

    expect(avatarName).toBe('dimfeld/llmutils');
    expect(selfOwnedDisplay).toBe('llmutils');
    expect(otherUserDisplay).toBe('dimfeld/llmutils');

    // Self-owned repo: abbreviation derived from display name (llmutils → LL), not avatar name (dimfeld/llmutils → DL)
    expect(getProjectAbbreviation(selfOwnedDisplay)).toBe('LL');
    // Other user's repo: abbreviation derived from display name which includes owner
    expect(getProjectAbbreviation(otherUserDisplay)).toBe('DL');
    // Color for same display name is stable
    expect(getProjectColor(otherUserDisplay)).toBe(getProjectColor('dimfeld/llmutils'));
  });
});

describe('getProjectAbbreviation', () => {
  test('two words separated by space', () => {
    expect(getProjectAbbreviation('My Project')).toBe('MP');
  });

  test('words separated by dashes', () => {
    expect(getProjectAbbreviation('widget-factory')).toBe('WF');
  });

  test('words separated by underscores', () => {
    expect(getProjectAbbreviation('hello_world')).toBe('HW');
  });

  test('words separated by dots', () => {
    expect(getProjectAbbreviation('com.example')).toBe('CE');
  });

  test('owner/repo format treats owner as first word', () => {
    expect(getProjectAbbreviation('acme/widget-factory')).toBe('AW');
  });

  test('owner and dotted repo names still use the first two words overall', () => {
    expect(getProjectAbbreviation('acme/widget.factory')).toBe('AW');
  });

  test('single word takes first two characters', () => {
    expect(getProjectAbbreviation('llmutils')).toBe('LL');
  });

  test('single short word', () => {
    expect(getProjectAbbreviation('ab')).toBe('AB');
  });

  test('single character returns a single-character abbreviation', () => {
    expect(getProjectAbbreviation('a')).toBe('A');
  });

  test('uppercases the result', () => {
    expect(getProjectAbbreviation('foo bar')).toBe('FB');
  });

  test('handles multiple separators', () => {
    expect(getProjectAbbreviation('my-cool_project thing')).toBe('MC');
  });

  test('empty string returns ??', () => {
    expect(getProjectAbbreviation('')).toBe('??');
  });

  test('ignores repeated separators', () => {
    expect(getProjectAbbreviation('alpha__beta--gamma')).toBe('AB');
  });
});

describe('getProjectColor', () => {
  test('returns a hex color string', () => {
    const color = getProjectColor('test-project');
    expect(color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  test('is deterministic', () => {
    const a = getProjectColor('my-project');
    const b = getProjectColor('my-project');
    expect(a).toBe(b);
  });

  test('returns a value from the palette', () => {
    const color = getProjectColor('some-project');
    expect(PROJECT_COLOR_PALETTE).toContain(color);
  });

  test('different names can produce different colors', () => {
    const colors = new Set<string>();
    const names = [
      'alpha',
      'beta',
      'gamma',
      'delta',
      'epsilon',
      'zeta',
      'eta',
      'theta',
      'iota',
      'kappa',
    ];
    for (const name of names) {
      colors.add(getProjectColor(name));
    }
    // With 10 names and 12 palette entries, we should get at least a few distinct colors
    expect(colors.size).toBeGreaterThan(1);
  });

  test('spreads a varied set of project names across the palette', () => {
    const colors = new Set(
      Array.from({ length: PROJECT_COLOR_PALETTE.length * 3 }, (_, index) =>
        getProjectColor(`project-${index}`)
      )
    );

    expect(colors.size).toBeGreaterThanOrEqual(PROJECT_COLOR_PALETTE.length - 2);
  });
});

describe('getContrastTextColor', () => {
  test('returns white for dark colors', () => {
    expect(getContrastTextColor('#000000')).toBe('white');
    expect(getContrastTextColor('#8e44ad')).toBe('white'); // dark purple
    expect(getContrastTextColor('#9b59b6')).toBe('white'); // purple
    expect(getContrastTextColor('#6c5ce7')).toBe('white'); // indigo
  });

  test('returns black for light colors', () => {
    expect(getContrastTextColor('#ffffff')).toBe('black');
    expect(getContrastTextColor('#f1c40f')).toBe('black'); // yellow
    expect(getContrastTextColor('#2ecc71')).toBe('black'); // green
    expect(getContrastTextColor('#e74c3c')).toBe('black'); // red (luminance ~0.22)
  });

  test('every palette color produces a readable result', () => {
    for (const color of PROJECT_COLOR_PALETTE) {
      const textColor = getContrastTextColor(color);
      expect(['white', 'black']).toContain(textColor);
    }
  });
});
