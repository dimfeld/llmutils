import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { cerebras, createCerebras } from '@ai-sdk/cerebras';
import { createGoogleGenerativeAI, google } from '@ai-sdk/google';
import { vertex } from '@ai-sdk/google-vertex';
import { createGroq, groq } from '@ai-sdk/groq';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { createXai, xai } from '@ai-sdk/xai';
import { createOpenRouter, openrouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { debugLog } from '../logging.ts';
import { loadEffectiveConfig } from '../tim/configLoader.ts';
import type { TimConfig } from '../tim/configSchema.ts';

/**
 * Gets the custom API key for a model based on the configuration.
 * Checks for exact matches first, then prefix matches.
 */
function getCustomApiKey(modelString: string, config?: TimConfig): string | undefined {
  if (!config?.modelApiKeys) {
    return undefined;
  }

  // Check for exact match first
  const envVarName = config.modelApiKeys[modelString];
  if (envVarName) {
    const apiKey = process.env[envVarName];
    if (apiKey) {
      debugLog(`Using custom API key from ${envVarName} for model ${modelString}`);
      return apiKey;
    } else {
      debugLog(
        `Custom API key environment variable ${envVarName} not found for model ${modelString}`
      );
    }
  }

  // Check for prefix matches (e.g., "openai/*" matches "openai/gpt-4")
  for (const [prefix, envVar] of Object.entries(config.modelApiKeys)) {
    if (prefix.endsWith('*') && modelString.startsWith(prefix.slice(0, -1))) {
      const apiKey = process.env[envVar];
      if (apiKey) {
        debugLog(
          `Using custom API key from ${envVar} for model ${modelString} (matched prefix: ${prefix})`
        );
        return apiKey;
      } else {
        debugLog(`Custom API key environment variable ${envVar} not found for prefix ${prefix}`);
      }
    }
  }

  return undefined;
}

/**
 * Creates a language model instance based on the provided model string in the format `provider/model-name`.
 * @param modelString The model identifier in the format `provider/model-name` (e.g., `openai/gpt-4o`, `anthropic/claude-3-5-sonnet-20241022`).
 * @param config Optional configuration that may contain custom API key mappings.
 * @returns A LanguageModel instance for the specified provider and model.
 * @throws Error if the provider or model is not supported.
 */
export async function createModel(modelString: string, config?: TimConfig): Promise<LanguageModel> {
  const parts = modelString.split('/');
  if (parts.length < 2) {
    throw new Error('Model string must be in the format "provider/model-name"');
  }

  const provider = parts[0];
  // Join all parts after provider to support slashes in model name
  const modelName = parts.slice(1).join('/');

  if (!provider || !modelName) {
    throw new Error('Model string must be in the format "provider/model-name"');
  }

  config ??= await loadEffectiveConfig();

  // Check for custom API key
  const customApiKey = getCustomApiKey(modelString, config);

  switch (provider.toLowerCase()) {
    case 'openai':
      return customApiKey ? createOpenAI({ apiKey: customApiKey })(modelName) : openai(modelName);
    case 'anthropic':
      return customApiKey
        ? createAnthropic({ apiKey: customApiKey })(modelName)
        : anthropic(modelName);
    case 'google':
      return customApiKey
        ? createGoogleGenerativeAI({ apiKey: customApiKey })(modelName)
        : google(modelName);
    case 'xai':
      return customApiKey ? createXai({ apiKey: customApiKey })(modelName) : xai(modelName);
    case 'openrouter':
      return customApiKey
        ? createOpenRouter({ apiKey: customApiKey })(modelName)
        : openrouter(modelName);
    case 'cerebras':
      return customApiKey
        ? createCerebras({ apiKey: customApiKey })(modelName)
        : cerebras(modelName);
    case 'groq':
      return customApiKey ? createGroq({ apiKey: customApiKey })(modelName) : groq(modelName);
    case 'vertex':
    case 'google-vertex':
      // Google Vertex doesn't use API keys, it uses project/location settings
      if (customApiKey) {
        debugLog(
          `Warning: Google Vertex doesn't use API keys. Ignoring custom API key for ${modelString}`
        );
      }
      return vertex(modelName);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
