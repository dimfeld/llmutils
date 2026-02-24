/**
 * @fileoverview Implementation of the `tim subagent` command.
 *
 * This command runs a subagent (implementer, tester, tdd-tests, or verifier) for the orchestrator.
 * It loads plan context, builds the appropriate agent prompt, and executes using either
 * claude-code or codex-cli. Intermediate output goes through the tunnel to the terminal,
 * while the final agent message is printed to stdout for the orchestrator to capture.
 */

import * as fs from 'fs/promises';
import * as path from 'node:path';
import { loadEffectiveConfig } from '../configLoader.js';
import { readPlanFile, resolvePlanFile } from '../plans.js';
import { getAllIncompleteTasks } from '../plans/find_next.js';
import { buildExecutionPromptWithoutSteps } from '../prompt_builder.js';
import {
  getImplementerPrompt,
  getTddTestsPrompt,
  getTesterPrompt,
  getVerifierAgentPrompt,
} from '../executors/claude_code/agent_prompts.js';
import { loadAgentInstructionsFor } from '../executors/codex_cli/agent_helpers.js';
import { executeCodexStep } from '../executors/codex_cli/codex_runner.js';
import { getGitRoot } from '../../common/git.js';
import { runClaudeSubprocess } from '../executors/claude_code/run_claude_subprocess.js';
import type { TimConfig } from '../configSchema.js';
import type { Executor } from '../executors/types.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { log } from '../../logging.js';

export type SubagentType = 'implementer' | 'tester' | 'tdd-tests' | 'verifier';

interface SubagentOptions {
  executor: string;
  model?: string;
  input?: string;
  inputFile?: string;
  outputFile?: string;
}

type SubagentExecutorModelKey = 'claude' | 'codex';
type SubagentConfigKey = 'implementer' | 'tester' | 'tddTests' | 'verifier' | 'reviewer';

/**
 * A minimal executor-like object that satisfies the Executor interface
 * requirements for buildExecutionPromptWithoutSteps. The subagent command
 * does not need a real executor for prompt building; it only needs the
 * filePathPrefix and todoDirections properties.
 */
const minimalExecutor: Pick<Executor, 'filePathPrefix' | 'todoDirections' | 'execute'> = {
  filePathPrefix: '@',
  todoDirections: '- Use the TodoWrite tool to maintain your TODO list.',
  execute: async () => {
    throw new Error('minimalExecutor.execute should not be called');
  },
};

/**
 * Handles the `tim subagent <type> <planFile>` command.
 *
 * Loads plan context, builds the subagent prompt with the appropriate role,
 * and executes using either claude-code or codex-cli. The final agent message
 * is printed to stdout.
 */
export async function handleSubagentCommand(
  agentType: SubagentType,
  planFileArg: string,
  options: SubagentOptions,
  globalCliOptions: any
): Promise<void> {
  const config = await loadEffectiveConfig(globalCliOptions.config);
  const planFilePath = await resolvePlanFile(planFileArg, globalCliOptions.config);
  const planData = await readPlanFile(planFilePath);
  const gitRoot = await getGitRoot(path.dirname(planFilePath));
  const executorType = options.executor || 'claude-code';
  const selectedModel = resolveSubagentModel(agentType, executorType, options.model, config);

  // Build the context prompt using the same pattern as batch_mode.ts
  const incompleteTasks = getAllIncompleteTasks(planData);
  const taskDescriptions = incompleteTasks
    .map((taskResult) => {
      const { taskIndex, task } = taskResult;
      let taskDescription = `Task ${taskIndex + 1}: ${task.title}`;
      if (task.description) {
        taskDescription += `\nDescription: ${task.description}`;
      }
      return taskDescription;
    })
    .join('\n\n');

  const contextContent = await buildExecutionPromptWithoutSteps({
    executor: minimalExecutor as Executor,
    planData,
    planFilePath,
    baseDir: gitRoot,
    config,
    task: {
      title: `${incompleteTasks.length} Tasks`,
      description: `Available tasks:\n\n${taskDescriptions}`,
      files: [],
    },
    filePathPrefix: '@',
    includeCurrentPlanContext: true,
    batchMode: true,
  });

  // Load custom agent instructions
  // @ts-expect-error not including 'test' for now
  const agentInstructionsType: 'implementer' | 'tester' | 'tddTests' | 'reviewer' =
    agentType === 'verifier' ? 'tester' : agentType === 'tdd-tests' ? 'tddTests' : agentType;
  const customInstructions = await loadAgentInstructionsFor(agentInstructionsType, gitRoot, config);

  // For verifier, also load reviewer instructions and combine them
  let combinedInstructions = customInstructions;
  if (agentType === 'verifier') {
    const reviewerInstructions = await loadAgentInstructionsFor('reviewer', gitRoot, config);
    const parts = [customInstructions, reviewerInstructions].filter((s): s is string =>
      Boolean(s?.trim())
    );
    combinedInstructions = parts.length > 0 ? parts.join('\n\n') : undefined;
  }

  const orchestratorInput = await resolveOrchestratorInput(options);

  // Combine custom instructions with orchestrator-provided input.
  const allInstructions = [combinedInstructions, orchestratorInput]
    .filter((s): s is string => Boolean(s?.trim()))
    .join('\n\n');

  const planId = planData.id?.toString() ?? 'unknown';

  // Build the agent prompt using the appropriate function
  const agentDefinition = buildAgentDefinition(
    agentType,
    contextContent,
    planId,
    allInstructions || undefined,
    selectedModel
  );

  // Execute using the selected executor
  let finalMessage: string;
  if (executorType === 'codex-cli') {
    finalMessage = await executeWithCodex(agentDefinition.prompt, gitRoot, config, selectedModel);
  } else {
    finalMessage = await executeWithClaude(agentDefinition.prompt, gitRoot, config, selectedModel);
  }

  if (options.outputFile) {
    await writeSubagentOutput(options.outputFile, finalMessage);
  }

  // Print final message to stdout for orchestrator to capture
  console.log(finalMessage);
  // Wait so that output flushes, this seems necessary in recent versions of Claude Code
  await Bun.sleep(500);

  if (isTunnelActive()) {
    log(`Subagent produced ${finalMessage.length} bytes of output`);
  }
}

async function writeSubagentOutput(outputFilePath: string, finalMessage: string): Promise<void> {
  await fs.mkdir(path.dirname(outputFilePath), { recursive: true });
  await fs.writeFile(outputFilePath, finalMessage, 'utf8');
}

async function resolveOrchestratorInput(options: SubagentOptions): Promise<string | undefined> {
  if (options.input && options.inputFile) {
    throw new Error('Cannot provide both --input and --input-file. Use only one.');
  }

  if (options.input) {
    return options.input;
  }

  if (options.inputFile) {
    if (options.inputFile === '-') {
      return readStdinText(true);
    }
    return fs.readFile(options.inputFile, 'utf8');
  }

  // Fallback for piped usage: allow orchestrator to pass large context via stdin
  // without needing to write a temporary file first.
  if (!process.stdin.isTTY) {
    const stdinText = await readStdinText(false);
    if (stdinText?.trim()) {
      return stdinText;
    }
  }

  return undefined;
}

async function readStdinText(requireInput: boolean): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    if (requireInput) {
      throw new Error('--input-file - requires input on stdin.');
    }
    return undefined;
  }

  const input = await Bun.stdin.text();
  if (!input.trim()) {
    if (requireInput) {
      throw new Error('No input received on stdin.');
    }
    return undefined;
  }

  return input;
}

/**
 * Builds the agent definition (prompt) for the given subagent type.
 */
function buildAgentDefinition(
  agentType: SubagentType,
  contextContent: string,
  planId: string,
  customInstructions: string | undefined,
  model: string | undefined
) {
  switch (agentType) {
    case 'implementer':
      return getImplementerPrompt(contextContent, planId, customInstructions, model, {
        mode: 'report',
      });
    case 'tester':
      return getTesterPrompt(contextContent, planId, customInstructions, model, {
        mode: 'report',
      });
    case 'tdd-tests':
      return getTddTestsPrompt(contextContent, planId, customInstructions, model, {
        mode: 'report',
      });
    case 'verifier':
      return getVerifierAgentPrompt(
        contextContent,
        planId,
        customInstructions,
        model,
        false,
        false,
        {
          mode: 'report',
        }
      );
  }
}

/**
 * Executes the subagent prompt using Codex CLI.
 * Follows the pattern from codex_runner.ts for tunneling setup.
 */
async function executeWithCodex(
  prompt: string,
  cwd: string,
  timConfig: TimConfig,
  model?: string
): Promise<string> {
  return executeCodexStep(prompt, cwd, timConfig, {
    appServerMode: 'single-turn-with-steering',
    model,
  });
}

/**
 * Executes the subagent prompt using Claude Code.
 */
async function executeWithClaude(
  prompt: string,
  cwd: string,
  timConfig: TimConfig,
  model?: string
): Promise<string> {
  const claudeCodeOptions = (timConfig.executors as Record<string, any>)?.['claude-code'] ?? {};
  const isNoninteractive = process.env.TIM_NONINTERACTIVE === 'true';

  let lastResultText: string | undefined;
  let lastAssistantRaw: string | undefined;

  const timeoutMs = 30 * 60 * 1000;
  const result = await runClaudeSubprocess({
    prompt,
    cwd,
    claudeCodeOptions,
    noninteractive: isNoninteractive,
    model,
    label: 'subagent',
    inactivityTimeoutMs: timeoutMs,
    extraAccessDirs:
      timConfig.isUsingExternalStorage && timConfig.externalRepositoryConfigDir
        ? [timConfig.externalRepositoryConfigDir]
        : undefined,
    processFormattedMessages: (messages) => {
      for (const formatted of messages) {
        if (formatted.type === 'result' && formatted.resultText) {
          lastResultText = formatted.resultText;
        }
        if (formatted.type === 'assistant' && formatted.rawMessage) {
          lastAssistantRaw = formatted.rawMessage;
        }
      }
    },
  });

  if ((result.killedByTimeout || result.killedByInactivity) && !result.seenResultMessage) {
    throw new Error(`Claude subagent timed out after ${Math.round(timeoutMs / 60000)} minutes`);
  }

  if (result.exitCode !== 0 && !result.seenResultMessage) {
    throw new Error(`Claude subagent exited with non-zero exit code: ${result.exitCode}`);
  }

  const finalMessage = lastResultText || lastAssistantRaw;
  if (!finalMessage) {
    throw new Error('No final agent message found in Claude subagent output.');
  }

  return finalMessage;
}

function resolveSubagentModel(
  agentType: SubagentType,
  executorType: string,
  cliModel: string | undefined,
  config: TimConfig
): string | undefined {
  if (cliModel?.trim()) {
    return cliModel;
  }

  const normalizedExecutor = normalizeSubagentExecutor(executorType);
  const subagentKey = toSubagentConfigKey(agentType);
  const configuredModel =
    config.subagents?.[subagentKey]?.model?.[normalizedExecutor] ||
    config.subagents?.[subagentKey]?.model?.[executorType as SubagentExecutorModelKey];
  if (configuredModel?.trim()) {
    return configuredModel;
  }

  // Backward compatibility for previous claude-only model settings.
  if (normalizedExecutor === 'claude') {
    const claudeAgents = (config.executors as Record<string, any> | undefined)?.['claude-code']
      ?.agents as Record<string, { model?: string } | undefined> | undefined;
    const legacyAgentKeys = toLegacyClaudeAgentKeys(agentType);
    for (const key of legacyAgentKeys) {
      const legacyModel = claudeAgents?.[key]?.model;
      if (legacyModel?.trim()) {
        return legacyModel;
      }
    }
  }

  return undefined;
}

function normalizeSubagentExecutor(executorType: string): SubagentExecutorModelKey {
  return executorType === 'codex-cli' ? 'codex' : 'claude';
}

function toSubagentConfigKey(agentType: SubagentType): SubagentConfigKey {
  if (agentType === 'tdd-tests') {
    return 'tddTests';
  }
  return agentType;
}

function toLegacyClaudeAgentKeys(agentType: SubagentType): SubagentConfigKey[] {
  switch (agentType) {
    case 'tdd-tests':
      return ['tddTests'];
    case 'verifier':
      return ['verifier', 'reviewer', 'tester'];
    default:
      return [agentType];
  }
}
