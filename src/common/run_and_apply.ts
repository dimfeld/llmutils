import { streamText, type StreamTextResult, type ToolSet } from 'ai';
import { streamResultToConsole } from './llm.ts';
import { createModel } from './model_factory.ts';

export const DEFAULT_RUN_MODEL = 'google/gemini-2.5-pro-exp-03-25';

export async function runStreamingPrompt(options: {
  input: string;
  model: string;
  format?: boolean;
  showReasoning?: boolean;
  temperature?: number;
  handleTextChunk?: (text: string) => void;
}): Promise<StreamTextResult<ToolSet, never>> {
  const result = streamText({
    model: createModel(options.model),
    temperature: options.temperature ?? 0,
    prompt: options.input,
  });

  return await streamResultToConsole(result, {
    format: options.format,
    showReasoning: options.showReasoning,
    cb: options?.handleTextChunk,
  });
}
