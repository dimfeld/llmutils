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
import {
  launchPreparedSubagent,
  preparePlanlessAdvisorExecution,
  prepareSubagentExecution,
} from '../subagents/index.js';
import type {
  PlanlessAdvisorPreparationRequest,
  PreparedSubagentExecutionBase,
  SubagentInputPolicy,
  SubagentPreparationRequest,
  SubagentType,
} from '../subagents/index.js';

export type { SubagentType } from '../subagents/index.js';
export { buildSubagentTaskContext } from '../subagents/index.js';

interface SubagentOptions {
  executor?: string;
  model?: string;
  difficulty?: 'low' | 'high';
  input?: string;
  inputFile?: string | string[];
  taskIndex?: string | string[];
  outputFile?: string;
}

interface GlobalCliOptions {
  config?: string;
}

/**
 * Handles the `tim subagent <type> [planFile]` command.
 *
 * This wrapper explicitly preserves the legacy stdin fallback and all command
 * output behavior. Preparation and provider execution do not depend on a
 * Commander command object.
 *
 * The plan ID is optional for the advisor only: a plan-less consultation reads
 * the local repository instead of a plan, which is what makes the advisor
 * reachable from planning, before a plan has any tasks.
 */
export async function handleSubagentCommand(
  agentType: SubagentType,
  planId: number | undefined,
  options: SubagentOptions,
  globalCliOptions: GlobalCliOptions
): Promise<void> {
  const inputPolicy: SubagentInputPolicy = {
    type: 'orchestrator',
    input: options.input,
    inputFile: options.inputFile,
    fallbackToStdin: true,
  };

  let prepared: PreparedSubagentExecutionBase;
  if (planId === undefined) {
    if (agentType !== 'advisor') {
      throw new Error(
        `The ${agentType} subagent requires a plan ID. Only 'tim subagent advisor' can run without one.`
      );
    }
    if (options.taskIndex !== undefined) {
      throw new Error(
        '--task-index requires a plan ID because it selects tasks from that plan. Pass a plan ID or drop the option.'
      );
    }

    const planlessRequest: PlanlessAdvisorPreparationRequest = {
      executor: options.executor,
      model: options.model,
      difficulty: options.difficulty,
      inputPolicy,
      configPath: globalCliOptions.config,
    };
    prepared = await preparePlanlessAdvisorExecution(planlessRequest);
  } else {
    const preparationRequest: SubagentPreparationRequest = {
      agentType,
      planId,
      executor: options.executor,
      model: options.model,
      difficulty: options.difficulty,
      inputPolicy,
      taskIndex: options.taskIndex,
      configPath: globalCliOptions.config,
    };
    prepared = await prepareSubagentExecution(preparationRequest);
  }

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
