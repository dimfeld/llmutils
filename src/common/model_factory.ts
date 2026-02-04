import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { cerebras, createCerebras } from '@ai-sdk/cerebras';
import { createGoogleGenerativeAI, google } from '@ai-sdk/google';
import { vertex } from '@ai-sdk/google-vertex';
import { createGroq, groq } from '@ai-sdk/groq';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { createXai, xai } from '@ai-sdk/xai';
import { search } from '@inquirer/prompts';
import { createOpenRouter, openrouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { debugLog } from '../logging.ts';
import { loadEffectiveConfig } from '../tim/configLoader.ts';
import type { TimConfig } from '../tim/configSchema.ts';
import { OneCallExecutorName } from '../tim/executors/index.js';
import {
  ClaudeCodeExecutor,
  CopyOnlyExecutor,
  CopyPasteExecutor,
  OneCallExecutor,
} from '../tim/executors/index.ts';

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
export async function createModel(
  modelString: string,
  config?: TimConfig
): Promise<LanguageModel> {
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

export async function askForModelId(options?: {
  defaultId?: string;
  /** Use this for code that isn't yet on the new executor model. */
  onlyDirectCall?: boolean;
}): Promise<{ value: string; executor: string } | null> {
  let availableModels = [
    'google/gemini-2.5-pro',
    'google/gemini-2.5-flash',
    'google/gemini-2.5-flash',
    'openai/o4-mini',
    'openai/gpt-4.1',
    'openai/gpt-4.1-mini',
    'openai/gpt-4.1-nano',
    'anthropic/claude-4-opus-latest',
    'anthropic/claude-4-sonnet-latest',
    'anthropic/claude-3.5-sonnet-latest',
    'anthropic/claude-3.5-haiku-latest',
    'anthropic/claude-3.7-sonnet-latest',
    'openrouter/anthropic/claude-opus-4',
    'openrouter/anthropic/claude-sonnet-4',
    'openrouter/anthropic/claude-3.5-sonnet',
    'openrouter/anthropic/claude-3.7-sonnet',
    'openrouter/anthropic/claude-3.5-haiku',
    'openrouter/openai/gpt-4.1',
    'openrouter/openai/gpt-4.1-mini',
    'openrouter/openai/gpt-4.1-nano',
    'openrouter/openai/o4-mini',
    'openrouter/google/gemini-2.5-pro',
    'openrouter/google/gemini-2.5-flash',
    { name: 'Claude Web', value: 'claude', executor: CopyPasteExecutor.name },
    { name: 'Gemini AI Studio', value: 'gemini', executor: CopyPasteExecutor.name },
    { name: 'Grok Web', value: 'grok', executor: CopyPasteExecutor.name },
    { name: 'Claude Code', value: 'claude_code', executor: ClaudeCodeExecutor.name },
    { name: 'Claude Code (Sonnet)', value: 'sonnet', executor: ClaudeCodeExecutor.name },
    { name: 'Claude Code (Opus)', value: 'opus', executor: ClaudeCodeExecutor.name },
    { name: 'Paste into Agent', value: 'paste_into_agent', executor: CopyOnlyExecutor.name },
  ].map((m) =>
    typeof m === 'string'
      ? {
          name: m,
          value: m,
          executor: OneCallExecutor.name,
        }
      : m
  );

  if (options?.onlyDirectCall) {
    availableModels = availableModels.filter((m) => m.executor === OneCallExecutor.name);
  }

  let newModel = await search({
    message: 'Select a model:',
    source: (input) => {
      return availableModels.filter(({ name }) =>
        input ? name.toLowerCase().includes(input.toLowerCase()) : true
      );
    },
  });
  debugLog({ newModel });

  if (options?.defaultId && !newModel) {
    newModel = options?.defaultId;
  }

  const modelSetting = availableModels.find((m) => m.value === newModel) ?? {
    name: newModel,
    value: newModel,
    executor: OneCallExecutorName,
  };

  return modelSetting;
}
