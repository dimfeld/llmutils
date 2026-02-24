import type { GoogleGenerativeAIProviderOptions } from '@ai-sdk/google';
import { streamText, type LanguageModel, type StreamTextResult, type ToolSet } from 'ai';
import { createModel } from '../../common/model_factory.ts';
import { streamResultToConsole } from './llm.js';

export const DEFAULT_RUN_MODEL = 'google/gemini-2.5-pro';

/** Represents a single message in a structured LLM prompt. */
export interface LlmPromptMessage {
  role: 'user' | 'assistant';
  content: string;
  cache_control?: {
    type?: 'ephemeral';
  };
}

/** Represents the structured prompt format for LLM interaction. */
export type LlmPromptStructure = LlmPromptMessage[];

export async function runStreamingPrompt(options: {
  input?: string;
  messages?: LlmPromptStructure;
  model: string | LanguageModel;
  format?: boolean;
  showReasoning?: boolean;
  temperature?: number;
  handleTextChunk?: (text: string) => void;
}): Promise<{ text: string; result: StreamTextResult<ToolSet, never> }> {
  const result = streamText({
    model: typeof options.model === 'string' ? await createModel(options.model) : options.model,
    temperature: options.temperature ?? 0,
    prompt: options.input,
    messages: options.messages,
    headers: {
      'X-Title': 'tim',
    },
    providerOptions: {
      google: {
        thinkingConfig: {
          includeThoughts: true,
        },
      } satisfies GoogleGenerativeAIProviderOptions,
    },
  });

  return await streamResultToConsole(result, {
    format: options.format,
    showReasoning: options.showReasoning,
    cb: options?.handleTextChunk,
  });
}

export interface RunPromptOptions {
  file: string;
  interactive?: boolean;
  model?: string;
}
