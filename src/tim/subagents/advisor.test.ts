import { describe, expect, test } from 'vitest';
import { resolveAdvisorConfiguration } from './advisor.js';
import type { TimConfig } from '../configSchema.js';

function config(subagents: TimConfig['subagents']): TimConfig {
  return { subagents } as TimConfig;
}

describe('resolveAdvisorConfiguration', () => {
  test('returns the claude executor and model when both are configured', () => {
    expect(
      resolveAdvisorConfiguration(
        config({ advisor: { executor: 'claude-code', model: { claude: 'opus' } } })
      )
    ).toEqual({ executor: 'claude-code', model: 'opus' });
  });

  test('returns the codex executor and model when both are configured', () => {
    expect(
      resolveAdvisorConfiguration(
        config({ advisor: { executor: 'codex-cli', model: { codex: 'gpt-5.6:high' } } })
      )
    ).toEqual({ executor: 'codex-cli', model: 'gpt-5.6:high' });
  });

  test('trims the configured model', () => {
    expect(
      resolveAdvisorConfiguration(
        config({ advisor: { executor: 'claude-code', model: { claude: '  opus  ' } } })
      )
    ).toEqual({ executor: 'claude-code', model: 'opus' });
  });

  test('uses only the model matching the configured executor', () => {
    expect(
      resolveAdvisorConfiguration(
        config({
          advisor: { executor: 'claude-code', model: { codex: 'gpt-5.6:high' } },
        })
      )
    ).toBeUndefined();

    expect(
      resolveAdvisorConfiguration(
        config({
          advisor: { executor: 'codex-cli', model: { claude: 'opus', codex: 'gpt-5.6:high' } },
        })
      )
    ).toEqual({ executor: 'codex-cli', model: 'gpt-5.6:high' });
  });

  test('returns undefined when the executor is missing', () => {
    expect(
      resolveAdvisorConfiguration(config({ advisor: { model: { claude: 'opus' } } }))
    ).toBeUndefined();
  });

  test('returns undefined when the model is missing or blank', () => {
    expect(
      resolveAdvisorConfiguration(config({ advisor: { executor: 'claude-code' } }))
    ).toBeUndefined();
    expect(
      resolveAdvisorConfiguration(
        config({ advisor: { executor: 'claude-code', model: { claude: '   ' } } })
      )
    ).toBeUndefined();
  });

  test('returns undefined when no advisor or no config is present', () => {
    expect(resolveAdvisorConfiguration(config({}))).toBeUndefined();
    expect(resolveAdvisorConfiguration({} as TimConfig)).toBeUndefined();
    expect(resolveAdvisorConfiguration(undefined)).toBeUndefined();
  });
});
