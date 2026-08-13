/**
 * @fileoverview Compatibility adapter for the `tim subagent` command.
 *
 * Reusable preparation and one-shot provider execution live in
 * `src/tim/subagents`. This module keeps the Commander-facing output policy:
 * optional output-file writing, final stdout, and tunnel byte-count logging.
 */

import * as fs from 'fs/promises';
import * as path from 'node:path';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { log } from '../../logging.js';
import { launchPreparedSubagent, prepareSubagentExecution } from '../subagents/index.js';
import type { SubagentPreparationRequest, SubagentType } from '../subagents/index.js';

export type { SubagentType } from '../subagents/index.js';
export { buildSubagentTaskContext } from '../subagents/index.js';

interface SubagentOptions {
  executor?: string;
  model?: string;
  input?: string;
  inputFile?: string | string[];
  taskIndex?: string | string[];
  outputFile?: string;
}

interface GlobalCliOptions {
  config?: string;
}

/**
 * Handles the `tim subagent <type> <planFile>` command.
 *
 * This wrapper explicitly preserves the legacy stdin fallback and all command
 * output behavior. Preparation and provider execution do not depend on a
 * Commander command object.
 */
export async function handleSubagentCommand(
  agentType: SubagentType,
  planId: number,
  options: SubagentOptions,
  globalCliOptions: GlobalCliOptions
): Promise<void> {
  const preparationRequest: SubagentPreparationRequest = {
    agentType,
    planId,
    executor: options.executor,
    model: options.model,
    input: options.input,
    inputFile: options.inputFile,
    taskIndex: options.taskIndex,
    configPath: globalCliOptions.config,
    fallbackToStdin: true,
  };
  const prepared = await prepareSubagentExecution(preparationRequest);
  const handle = launchPreparedSubagent(prepared);
  const { finalMessage } = await handle.completion;

  if (options.outputFile) {
    await writeSubagentOutput(options.outputFile, finalMessage);
  }

  console.log(finalMessage);

  if (isTunnelActive()) {
    log(`Subagent produced ${finalMessage.length} bytes of output`);
  }
}

async function writeSubagentOutput(outputFilePath: string, finalMessage: string): Promise<void> {
  await fs.mkdir(path.dirname(outputFilePath), { recursive: true });
  await fs.writeFile(outputFilePath, finalMessage, 'utf8');
}
