import { describe, expect, test } from 'vitest';
import { getCodexModelProviderArgs } from './model_provider.js';

describe('Codex provider arguments', () => {
  test.each([undefined, '', '  '])(
    'uses Codex configuration when the provider is %s',
    (provider: string | undefined): void => {
      expect(getCodexModelProviderArgs({ TIM_CODEX_MODEL_PROVIDER: provider })).toEqual([]);
    }
  );

  test('encodes the provider as a TOML string', (): void => {
    const provider = 'custom"provider';
    expect(getCodexModelProviderArgs({ TIM_CODEX_MODEL_PROVIDER: provider })).toEqual([
      '-c',
      `model_provider=${JSON.stringify(provider)}`,
    ]);
  });
});
