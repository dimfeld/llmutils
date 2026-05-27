import { describe, expect, test } from 'vitest';
import { parseSlackProjectSetting } from './slack_project_setting.js';

describe('common/slack/slack_project_setting', () => {
  test('parses boolean daily digest settings while preserving other fields', () => {
    expect(
      parseSlackProjectSetting({
        enabled: true,
        workspace: 'work',
        channel: '#reviews',
        dailyDigest: true,
      })
    ).toEqual({
      enabled: true,
      workspace: 'work',
      channel: '#reviews',
      dailyDigest: true,
    });

    expect(
      parseSlackProjectSetting({
        enabled: false,
        workspace: 'personal',
        channel: '#quiet',
        dailyDigest: false,
      })
    ).toEqual({
      enabled: false,
      workspace: 'personal',
      channel: '#quiet',
      dailyDigest: false,
    });
  });

  test('ignores non-boolean daily digest values while preserving valid fields', () => {
    expect(
      parseSlackProjectSetting({
        enabled: true,
        workspace: 'work',
        channel: '#reviews',
        dailyDigest: 'true',
      })
    ).toEqual({
      enabled: true,
      workspace: 'work',
      channel: '#reviews',
      dailyDigest: undefined,
    });

    expect(
      parseSlackProjectSetting({
        enabled: true,
        workspace: 'work',
        channel: '#reviews',
        dailyDigest: 1,
      })
    ).toEqual({
      enabled: true,
      workspace: 'work',
      channel: '#reviews',
      dailyDigest: undefined,
    });
  });
});
