import type { GoogleGenerativeAIProviderOptions } from '@ai-sdk/google';
import type { OpenRouterProviderOptions } from '@openrouter/ai-sdk-provider';
import { streamText, type LanguageModel, type StreamTextResult, type ToolSet } from 'ai';
import { streamResultToConsole } from './llm.js';
import { askForModelId, createModel } from '../../common/model_factory.ts';
import { log } from '../../logging.ts';
import { applyLlmEdits } from '../../apply-llm-edits/apply.ts';
import { createRetryRequester } from '../../apply-llm-edits/retry.ts';

export const DEFAULT_RUN_MODEL = 'google/gemini-2.5-pro-preview-05-06';

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
    model: typeof options.model === 'string' ? createModel(options.model) : options.model,
    temperature: options.temperature ?? 0,
    prompt: options.input,
    messages: options.messages,
    headers: {
      'X-Title': 'rmplan',
    },
    providerOptions: {
      google: {
        thinkingConfig: {
          include_thoughts: true,
        },
      } as GoogleGenerativeAIProviderOptions,
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

export async function runPrompt(options: RunPromptOptions) {
  let model = options.model;
  if (!model) {
    model =
      (
        await askForModelId({
          onlyDirectCall: true,
        })
      )?.value ?? DEFAULT_RUN_MODEL;
  }

  let input = await Bun.file(options.file).text();

  const outputFile = Bun.file('repomix-result.txt');
  // Bun won't truncate the existing content when using a file writer
  await outputFile.unlink();
  const fileWriter = outputFile.writer();

  const result = await runStreamingPrompt({
    input,
    model,

    handleTextChunk: (text: string) => {
      fileWriter.write(new TextEncoder().encode(text));
    },
  });

  await fileWriter.end();
  log('\nWrote to repomix-result.txt. Applying...');

  const content = result.text;
  await applyLlmEdits({
    content,
    originalPrompt: input,
    retryRequester: createRetryRequester(model),
    interactive: options.interactive ?? false,
  });
}
