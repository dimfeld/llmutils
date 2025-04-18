import { anthropic } from '@ai-sdk/anthropic';
import { cerebras } from '@ai-sdk/cerebras';
import { google } from '@ai-sdk/google';
import { groq } from '@ai-sdk/groq';
import { openai } from '@ai-sdk/openai';
import { xai } from '@ai-sdk/xai';
import { openrouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';

/**
 * Creates a language model instance based on the provided model string in the format `provider/model-name`.
 * @param modelString The model identifier in the format `provider/model-name` (e.g., `openai/gpt-4o`, `anthropic/claude-3-5-sonnet-20241022`).
 * @returns A LanguageModel instance for the specified provider and model.
 * @throws Error if the provider or model is not supported.
 */
export function createModel(modelString: string): LanguageModel {
  const parts = modelString.split('/');
  if (parts.length < 2) {
    throw new Error('Model string must be in the format "provider/model-name"');
  }

  const provider = parts[0];
  const modelName = parts.slice(1).join('/'); // Join all parts after provider to support slashes in model name

  if (!provider || !modelName) {
    throw new Error('Model string must be in the format "provider/model-name"');
  }

  switch (provider.toLowerCase()) {
    case 'openai':
      return openai(modelName);
    case 'anthropic':
      return anthropic(modelName);
    case 'google':
      return google(modelName);
    case 'xai':
      return xai(modelName);
    case 'openrouter':
      return openrouter(modelName);
    case 'cerebras':
      return cerebras(modelName);
    case 'groq':
      return groq(modelName);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
