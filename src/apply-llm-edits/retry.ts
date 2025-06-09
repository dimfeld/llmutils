import { confirm } from '@inquirer/prompts';
import { createModel } from '../common/model_factory.ts';
import { runStreamingPrompt, type LlmPromptStructure } from '../common/run_and_apply.ts';
import type { NoMatchFailure, NotUniqueFailure } from '../editor/types.ts';
import { debugLog, error } from '../logging.ts';
import { getCommandFilePath, getOutputPath } from '../rmfilter/repomix.ts';
import { runRmfilterProgrammatically } from '../rmfilter/rmfilter.ts';
import { extractRmfilterCommandArgs, type ApplyLlmEditsOptions } from './apply.ts';
import { formatFailuresForLlm } from './failures.ts';

/** Type definition for the callback function used to request LLM completions. */
export type RetryRequester = (prompt: LlmPromptStructure) => Promise<string>;

export function createRetryRequester(modelId: string): RetryRequester {
  return async (messages: LlmPromptStructure) => {
    const model = await createModel(modelId);
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
 * Retrieves the original context (prompt) used to generate the LLM response,
 * and reruns rmfilter to get the current file content.
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

  let commandsPath = options.contentCommandsFilename;
  if (!commandsPath) {
    commandsPath = getCommandFilePath(await getOutputPath());
  }

  let contextContent: string;
  try {
    contextContent = await Bun.file(commandsPath).text();
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      throw e;
    } else {
      throw new Error(`No cached rmfilter output found at: ${commandsPath}`);
    }
  }

  const result = extractRmfilterCommandArgs(contextContent, options.content);

  if (result?.promptMessage && options.interactive) {
    let keepGoing = await confirm({
      message: result.promptMessage,
      default: true,
    });

    if (!keepGoing) {
      throw new Error('Not continuing due to command ID mismatch');
    }
  }

  let argsFromContext = result?.commands ?? null;
  if (!argsFromContext) {
    throw new Error(`No rmfilter command found in cached rmfilter output at: ${commandsPath}`);
  }

  debugLog('Running rmfilter programmatically with args:', argsFromContext);
  try {
    const regeneratedOutput = await runRmfilterProgrammatically(argsFromContext, gitRoot, baseDir);
    return regeneratedOutput;
  } catch (err) {
    error('Error running rmfilter programmatically to regenerate context:', err);
    throw new Error(
      `Failed to regenerate original rmfilter context by re-running command: ${argsFromContext.join(' ')}`
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
