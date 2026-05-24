import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { getDefaultConfig, type TimConfig } from '../../tim/configSchema.js';
import { resolveSlackWorkspaceToken } from './slack_config.js';

describe('common/slack/slack_config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function buildConfig(slack: TimConfig['slack']): TimConfig {
    return {
      ...getDefaultConfig(),
      slack,
    };
  }

  test('returns a literal configured token unchanged', () => {
    const config = buildConfig({
      workspaces: {
        work: { token: 'xoxb-literal-token' },
      },
    });

    expect(resolveSlackWorkspaceToken(config, 'work')).toBe('xoxb-literal-token');
  });

  test('expands a token that is entirely an environment variable placeholder', () => {
    process.env.SLACK_WORK_TOKEN = 'xoxb-env-token';
    const config = buildConfig({
      workspaces: {
        work: { token: '${SLACK_WORK_TOKEN}' },
      },
    });

    expect(resolveSlackWorkspaceToken(config, 'work')).toBe('xoxb-env-token');
  });

  test('expands environment variable placeholders embedded in a larger token', () => {
    process.env.SLACK_TOKEN_SUFFIX = 'suffix';
    const config = buildConfig({
      workspaces: {
        work: { token: 'xoxb-${SLACK_TOKEN_SUFFIX}' },
      },
    });

    expect(resolveSlackWorkspaceToken(config, 'work')).toBe('xoxb-suffix');
  });

  test('throws with defined workspace names when the requested workspace is missing', () => {
    const config = buildConfig({
      workspaces: {
        personal: { token: 'xoxb-personal' },
        work: { token: 'xoxb-work' },
      },
    });

    expect(() => resolveSlackWorkspaceToken(config, 'missing')).toThrow(
      'Slack workspace "missing" is not configured. Defined Slack workspaces: personal, work.'
    );
  });

  test('throws none configured when no workspaces map exists', () => {
    const config = buildConfig(undefined);

    expect(() => resolveSlackWorkspaceToken(config, 'work')).toThrow(
      'Slack workspace "work" is not configured. Defined Slack workspaces: none configured.'
    );
  });

  test('throws when a workspace token is missing or empty', () => {
    const missingTokenConfig = buildConfig({
      workspaces: {
        work: {},
      },
    });
    const emptyTokenConfig = buildConfig({
      workspaces: {
        work: { token: '   ' },
      },
    });

    expect(() => resolveSlackWorkspaceToken(missingTokenConfig, 'work')).toThrow(
      'Slack workspace "work" has no bot token configured.'
    );
    expect(() => resolveSlackWorkspaceToken(emptyTokenConfig, 'work')).toThrow(
      'Slack workspace "work" has no bot token configured.'
    );
  });

  test('throws when a referenced environment variable is unset or empty', () => {
    delete process.env.SLACK_WORK_TOKEN;
    const unsetConfig = buildConfig({
      workspaces: {
        work: { token: '${SLACK_WORK_TOKEN}' },
      },
    });

    expect(() => resolveSlackWorkspaceToken(unsetConfig, 'work')).toThrow(
      'Slack workspace "work" references environment variable "SLACK_WORK_TOKEN", but it is unset or empty.'
    );

    process.env.SLACK_WORK_TOKEN = '';
    expect(() => resolveSlackWorkspaceToken(unsetConfig, 'work')).toThrow(
      'Slack workspace "work" references environment variable "SLACK_WORK_TOKEN", but it is unset or empty.'
    );
  });
});
