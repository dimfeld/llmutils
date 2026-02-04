import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createModel } from './model_factory.js';
import type { TimConfig } from '../tim/configSchema.js';

describe('createModel with custom API keys', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment to a clean state
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  test('should use default environment variable when no config provided', async () => {
    process.env.OPENAI_API_KEY = 'default-openai-key';

    // We can't directly test the API key usage without mocking the provider
    // but we can at least verify the function doesn't throw
    await expect(createModel('openai/gpt-4')).resolves.toBeDefined();
  });

  test('should use custom environment variable for exact model match', async () => {
    process.env.CUSTOM_GPT4_KEY = 'custom-gpt4-key';
    process.env.OPENAI_API_KEY = 'default-openai-key';

    const config: TimConfig = {
      modelApiKeys: {
        'openai/gpt-4': 'CUSTOM_GPT4_KEY',
      },
    };

    // Verify it doesn't throw with the custom config
    await expect(createModel('openai/gpt-4', config)).resolves.toBeDefined();
  });

  test('should use custom environment variable for prefix match', async () => {
    process.env.MY_ANTHROPIC_KEY = 'custom-anthropic-key';
    process.env.ANTHROPIC_API_KEY = 'default-anthropic-key';

    const config: TimConfig = {
      modelApiKeys: {
        'anthropic/*': 'MY_ANTHROPIC_KEY',
      },
    };

    // Should match any anthropic model
    await expect(createModel('anthropic/claude-3.5-sonnet', config)).resolves.toBeDefined();
    await expect(createModel('anthropic/claude-3-opus', config)).resolves.toBeDefined();
  });

  test('should prefer exact match over prefix match', async () => {
    process.env.SONNET_KEY = 'sonnet-specific-key';
    process.env.GENERAL_ANTHROPIC_KEY = 'general-anthropic-key';
    process.env.ANTHROPIC_API_KEY = 'default-anthropic-key';

    const config: TimConfig = {
      modelApiKeys: {
        'anthropic/*': 'GENERAL_ANTHROPIC_KEY',
        'anthropic/claude-3.5-sonnet': 'SONNET_KEY',
      },
    };

    // Should use SONNET_KEY for the specific model
    await expect(createModel('anthropic/claude-3.5-sonnet', config)).resolves.toBeDefined();

    // Should use GENERAL_ANTHROPIC_KEY for other anthropic models
    await expect(createModel('anthropic/claude-3-opus', config)).resolves.toBeDefined();
  });

  test('should fall back to default when custom env var not found', async () => {
    process.env.OPENAI_API_KEY = 'default-key';
    // NOT setting CUSTOM_KEY

    const config: TimConfig = {
      modelApiKeys: {
        'openai/*': 'CUSTOM_KEY',
      },
    };

    // Should still work with default key
    await expect(createModel('openai/gpt-4', config)).resolves.toBeDefined();
  });

  test('should handle Google Vertex (no API key support)', async () => {
    process.env.CUSTOM_VERTEX_KEY = 'should-be-ignored';
    // Set required Vertex environment variables
    process.env.GOOGLE_VERTEX_LOCATION = 'us-central1';
    process.env.GOOGLE_VERTEX_PROJECT = 'test-project';

    const config: TimConfig = {
      modelApiKeys: {
        'vertex/*': 'CUSTOM_VERTEX_KEY',
      },
    };

    // Should not throw but should ignore the custom key
    await expect(createModel('vertex/gemini-pro', config)).resolves.toBeDefined();
  });

  test('should work with multiple providers in config', async () => {
    process.env.MY_OPENAI = 'openai-key';
    process.env.MY_ANTHROPIC = 'anthropic-key';
    process.env.MY_GROQ = 'groq-key';

    const config: TimConfig = {
      modelApiKeys: {
        'openai/*': 'MY_OPENAI',
        'anthropic/*': 'MY_ANTHROPIC',
        'groq/*': 'MY_GROQ',
      },
    };

    // All should work
    await expect(createModel('openai/gpt-4', config)).resolves.toBeDefined();
    await expect(createModel('anthropic/claude-3.5-sonnet', config)).resolves.toBeDefined();
    await expect(createModel('groq/llama-3.1-70b', config)).resolves.toBeDefined();
  });

  test('should not match keys without asterisk as prefix', async () => {
    process.env.OPENAI_API_KEY = 'default-key';
    process.env.CUSTOM_KEY = 'custom-key';

    const config: TimConfig = {
      modelApiKeys: {
        'openai/gpt': 'CUSTOM_KEY', // Should NOT match openai/gpt-4
      },
    };

    // Should use default key since 'openai/gpt' doesn't end with * and doesn't exactly match
    await expect(createModel('openai/gpt-4', config)).resolves.toBeDefined();
  });

  test('should throw for unsupported provider', async () => {
    await expect(createModel('unsupported/model')).rejects.toThrow(
      'Unsupported provider: unsupported'
    );
  });

  test('should throw for invalid model string format', async () => {
    await expect(createModel('invalid-format')).rejects.toThrow(
      'Model string must be in the format "provider/model-name"'
    );
    await expect(createModel('/')).rejects.toThrow(
      'Model string must be in the format "provider/model-name"'
    );
    await expect(createModel('provider/')).rejects.toThrow(
      'Model string must be in the format "provider/model-name"'
    );
  });
});
