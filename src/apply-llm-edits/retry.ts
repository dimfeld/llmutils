import { streamText } from 'ai';
import { createModel } from '../common/model_factory.ts';
import type { NoMatchFailure, NotUniqueFailure } from '../editor/types.ts';
import { debugLog, warn, error } from '../logging.ts';
import { getOutputPath } from '../rmfilter/repomix.ts';
import { runRmfilterProgrammatically } from '../rmfilter/rmfilter.ts';
import { extractRmfilterCommandArgs, type ApplyLlmEditsOptions } from './apply.ts';
import { formatFailuresForLlm } from './failures.ts';
import * as path from 'path';
import { runStreamingPrompt, type LlmPromptStructure } from '../common/run_and_apply.ts';

/** Type definition for the callback function used to request LLM completions. */
export type RetryRequester = (prompt: LlmPromptStructure) => Promise<string>;

export function createRetryRequester(modelId: string): RetryRequester {
  const model = createModel(modelId);
  return async (messages: LlmPromptStructure) => {
    const { text } = await runStreamingPrompt({
      model,
      messages,
      // Give it a little more temperature when retrying
      temperature: 0.1,
    });

    return text;
  };
}

/**
 * Retrieves the original context (prompt) used to generate the LLM response.
 * It prioritizes the explicitly provided prompt, then tries to use a cached
 * rmfilter output if the command matches, and finally re-runs rmfilter if necessary.
 */
export async function getOriginalRequestContext(
  options: ApplyLlmEditsOptions,
  gitRoot: string,
  baseDir: string
): Promise<string> {
  if (options.originalPrompt) {
    debugLog('Using provided original prompt.');
    return options.originalPrompt;
  }

  debugLog('Attempting to retrieve original context via rmfilter command.');
  const currentArgs = extractRmfilterCommandArgs(options.content);
  if (!currentArgs) {
    throw new Error(
      'Cannot retry: Original prompt not provided and <rmfilter_command> tag not found or empty in the LLM response content.'
    );
  }

  const outputPath = path.resolve(gitRoot, await getOutputPath());
  let cachedContent: string | null = null;
  let cachedArgs: string[] | null = null;

  try {
    cachedContent = await Bun.file(outputPath).text();
    cachedArgs = extractRmfilterCommandArgs(cachedContent);
    debugLog(`Found cached rmfilter output at: ${outputPath}`);
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      warn(`Error reading cached rmfilter output at ${outputPath}:`, e.message);
    } else {
      debugLog(`No cached rmfilter output found at: ${outputPath}`);
    }
  }

  let argsMatch = false;
  if (cachedArgs && currentArgs) {
    // Compare arguments ignoring order
    const currentSet = new Set(currentArgs);
    const cachedSet = new Set(cachedArgs);
    if (currentSet.size === cachedSet.size && [...currentSet].every((arg) => cachedSet.has(arg))) {
      argsMatch = true;
    }
  }

  if (cachedContent && argsMatch) {
    debugLog('Using cached rmfilter output as original context (arguments match).');
    return cachedContent;
  }

  if (cachedContent && !argsMatch) {
    warn(
      `Cached rmfilter output at ${outputPath} is stale (command arguments mismatch). Re-running rmfilter.`
    );
  } else if (!cachedContent) {
    debugLog('No matching cached rmfilter output found. Re-running rmfilter.');
  }

  debugLog('Running rmfilter programmatically with args:', currentArgs);
  try {
    const regeneratedOutput = await runRmfilterProgrammatically(currentArgs, gitRoot, baseDir);
    return regeneratedOutput;
  } catch (err) {
    error('Error running rmfilter programmatically to regenerate context:', err);
    throw new Error(
      `Failed to regenerate original rmfilter context by re-running command: ${currentArgs.join(' ')}`
    );
  }
}

export function constructRetryMessage(failures: (NoMatchFailure | NotUniqueFailure)[]): string {
  const formattedFailures = formatFailuresForLlm(failures);

  const finalUserMessageContent = `The previous attempt to apply the edits resulted in the following errors:

${formattedFailures}

Please review the original request context, your previous response, and the errors listed above. Provide a corrected set of edits in the same format as before, addressing these issues. Ensure the SEARCH blocks exactly match the current file content where the changes should be applied, or provide correct unified diffs.`;

  return finalUserMessageContent;
}

/**
 * Constructs the structured prompt for requesting the LLM to retry failed edits.
 * @param originalRequestContext The original prompt or context provided to the LLM.
 * @param failedLlmOutput The LLM's previous response that resulted in failures.
 * @param failures An array of failure objects detailing what went wrong.
 * @returns An LlmPromptStructure array ready for the LLM request.
 */
export function constructRetryPrompt(
  originalRequestContext: string,
  failedLlmOutput: string,
  failures: (NoMatchFailure | NotUniqueFailure)[]
): LlmPromptStructure {
  const retryMessage = constructRetryMessage(failures);

  const promptStructure: LlmPromptStructure = [
    { role: 'user', content: originalRequestContext },
    { role: 'assistant', content: failedLlmOutput },
    { role: 'user', content: retryMessage },
  ];

  debugLog('Constructed retry prompt structure:', promptStructure);

  return promptStructure;
}
