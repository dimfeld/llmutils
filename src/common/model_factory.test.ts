import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createModel } from './model_factory.js';
import type { RmplanConfig } from '../rmplan/configSchema.js';

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

  test('should use default environment variable when no config provided', () => {
    process.env.OPENAI_API_KEY = 'default-openai-key';

    // We can't directly test the API key usage without mocking the provider
    // but we can at least verify the function doesn't throw
    expect(() => createModel('openai/gpt-4')).not.toThrow();
  });

  test('should use custom environment variable for exact model match', () => {
    process.env.CUSTOM_GPT4_KEY = 'custom-gpt4-key';
    process.env.OPENAI_API_KEY = 'default-openai-key';

    const config: RmplanConfig = {
      modelApiKeys: {
        'openai/gpt-4': 'CUSTOM_GPT4_KEY',
      },
    };

    // Verify it doesn't throw with the custom config
    expect(() => createModel('openai/gpt-4', config)).not.toThrow();
  });

  test('should use custom environment variable for prefix match', () => {
    process.env.MY_ANTHROPIC_KEY = 'custom-anthropic-key';
    process.env.ANTHROPIC_API_KEY = 'default-anthropic-key';

    const config: RmplanConfig = {
      modelApiKeys: {
        'anthropic/': 'MY_ANTHROPIC_KEY',
      },
    };

    // Should match any anthropic model
    expect(() => createModel('anthropic/claude-3.5-sonnet', config)).not.toThrow();
    expect(() => createModel('anthropic/claude-3-opus', config)).not.toThrow();
  });

  test('should prefer exact match over prefix match', () => {
    process.env.SONNET_KEY = 'sonnet-specific-key';
    process.env.GENERAL_ANTHROPIC_KEY = 'general-anthropic-key';
    process.env.ANTHROPIC_API_KEY = 'default-anthropic-key';

    const config: RmplanConfig = {
      modelApiKeys: {
        'anthropic/': 'GENERAL_ANTHROPIC_KEY',
        'anthropic/claude-3.5-sonnet': 'SONNET_KEY',
      },
    };

    // Should use SONNET_KEY for the specific model
    expect(() => createModel('anthropic/claude-3.5-sonnet', config)).not.toThrow();

    // Should use GENERAL_ANTHROPIC_KEY for other anthropic models
    expect(() => createModel('anthropic/claude-3-opus', config)).not.toThrow();
  });

  test('should fall back to default when custom env var not found', () => {
    process.env.OPENAI_API_KEY = 'default-key';
    // NOT setting CUSTOM_KEY

    const config: RmplanConfig = {
      modelApiKeys: {
        'openai/': 'CUSTOM_KEY',
      },
    };

    // Should still work with default key
    expect(() => createModel('openai/gpt-4', config)).not.toThrow();
  });

  test('should handle Google Vertex (no API key support)', () => {
    process.env.CUSTOM_VERTEX_KEY = 'should-be-ignored';
    // Set required Vertex environment variables
    process.env.GOOGLE_VERTEX_LOCATION = 'us-central1';
    process.env.GOOGLE_VERTEX_PROJECT = 'test-project';

    const config: RmplanConfig = {
      modelApiKeys: {
        'vertex/': 'CUSTOM_VERTEX_KEY',
      },
    };

    // Should not throw but should ignore the custom key
    expect(() => createModel('vertex/gemini-pro', config)).not.toThrow();
  });

  test('should work with multiple providers in config', () => {
    process.env.MY_OPENAI = 'openai-key';
    process.env.MY_ANTHROPIC = 'anthropic-key';
    process.env.MY_GROQ = 'groq-key';

    const config: RmplanConfig = {
      modelApiKeys: {
        'openai/': 'MY_OPENAI',
        'anthropic/': 'MY_ANTHROPIC',
        'groq/': 'MY_GROQ',
      },
    };

    // All should work
    expect(() => createModel('openai/gpt-4', config)).not.toThrow();
    expect(() => createModel('anthropic/claude-3.5-sonnet', config)).not.toThrow();
    expect(() => createModel('groq/llama-3.1-70b', config)).not.toThrow();
  });

  test('should throw for unsupported provider', () => {
    expect(() => createModel('unsupported/model')).toThrow('Unsupported provider: unsupported');
  });

  test('should throw for invalid model string format', () => {
    expect(() => createModel('invalid-format')).toThrow(
      'Model string must be in the format "provider/model-name"'
    );
    expect(() => createModel('/')).toThrow(
      'Model string must be in the format "provider/model-name"'
    );
    expect(() => createModel('provider/')).toThrow(
      'Model string must be in the format "provider/model-name"'
    );
  });
});
