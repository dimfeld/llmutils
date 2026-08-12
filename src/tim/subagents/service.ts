import * as path from 'node:path';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanByNumericId } from '../plans.js';
import { getAllIncompleteTasks } from '../plans/find_next.js';
import { resolveSubagentTaskScope } from '../plans/task_scope.js';
import { buildExecutionPromptWithoutSteps } from '../prompt_builder.js';
import {
  getImplementerPrompt,
  getReviewerPrompt,
  getTddTestsPrompt,
  getTesterPrompt,
} from '../executors/claude_code/agent_prompts.js';
import { loadAgentInstructionsFor } from '../executors/codex_cli/agent_helpers.js';
import { executeCodexStep } from '../executors/codex_cli/codex_runner.js';
import { parseCodexModel } from '../executors/codex_cli/model.js';
import { getGitRoot, getUsingJj } from '../../common/git.js';
import { runClaudeSubprocess } from '../executors/claude_code/run_claude_subprocess.js';
import type { TimConfig } from '../configSchema.js';
import type { Executor } from '../executors/types.js';
import { resolveOrchestratorInput } from '../utils/orchestrator_input.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { materializePlan } from '../plan_materialize.js';
import { buildTimWorkspaceCommandEnvironmentOptionsForPath } from '../environment_options.js';
import { tryMaterializeReferenceArtifactPathsForExecution } from '../reference_artifacts.js';
import type {
  PreparedSubagentExecution,
  PreparedSubagentType,
  SubagentExecutor,
  SubagentInputPolicy,
  SubagentLaunchHandle,
  SubagentPreparationRequest,
  SubagentPromptContext,
} from './types.js';
import type { PlanSchema } from '../planSchema.js';
import type { ClaudeCodeSubprocessOptions } from '../executors/claude_code/run_claude_subprocess.js';

type SubagentExecutorModelKey = 'claude' | 'codex';
type SubagentConfigKey = 'implementer' | 'tester' | 'tddTests' | 'reviewer';
type SubagentInstructionKey = 'implementer' | 'tester' | 'tddTests' | 'reviewer';

type SubagentPromptBuilder = (
  contextContent: string,
  planId: string,
  customInstructions: string | undefined,
  model: string | undefined,
  progressGuidanceOptions: { mode: 'report'; useJj: boolean },
  promptContext?: SubagentPromptContext
) => { name: string; prompt: string };

interface SubagentRoleDefinition {
  instructionKey: SubagentInstructionKey;
  configKey: SubagentConfigKey;
  legacyClaudeModelKey: string;
  promptBuilder: SubagentPromptBuilder;
}

export const ROLE_DEFINITIONS = {
  implementer: {
    instructionKey: 'implementer',
    configKey: 'implementer',
    legacyClaudeModelKey: 'implementer',
    promptBuilder: getImplementerPrompt,
  },
  tester: {
    instructionKey: 'tester',
    configKey: 'tester',
    legacyClaudeModelKey: 'tester',
    promptBuilder: getTesterPrompt,
  },
  'tdd-tests': {
    instructionKey: 'tddTests',
    configKey: 'tddTests',
    legacyClaudeModelKey: 'tddTests',
    promptBuilder: getTddTestsPrompt,
  },
  reviewer: {
    instructionKey: 'reviewer',
    configKey: 'reviewer',
    legacyClaudeModelKey: 'reviewer',
    promptBuilder: (
      contextContent: string,
      planId: string,
      customInstructions: string | undefined,
      model: string | undefined,
      progressGuidanceOptions: { mode: 'report'; useJj: boolean },
      promptContext?: SubagentPromptContext
    ) =>
      getReviewerPrompt(contextContent, {
        planId,
        customInstructions,
        model,
        progressGuidanceOptions,
        promptContext,
      }),
  },
} satisfies Record<PreparedSubagentType, SubagentRoleDefinition>;

/**
 * A minimal executor-like object used only while constructing the prompt.
 * Provider execution happens later through the prepared execution adapters.
 */
const minimalExecutor: Pick<Executor, 'filePathPrefix' | 'todoDirections' | 'execute'> = {
  filePathPrefix: '@',
  todoDirections: '- Use the TodoWrite tool to maintain your TODO list.',
  execute: async () => {
    throw new Error('minimalExecutor.execute should not be called');
  },
};

/**
 * Builds the task-context section for a one-shot subagent prompt.
 *
 * With no task-index filter, every incomplete plan task is listed under the
 * standard intro. With a filter, only the named tasks are listed and the intro
 * states that other plan work is out of scope. Both branches number tasks with
 * their plan-absolute 1-based index, so the numbering an orchestrator reads
 * from a review matches the numbering it passes back in `--task-index`.
 *
 * Throws when a supplied index is invalid, out of range, or already done.
 */
export function buildSubagentTaskContext(
  planData: PlanSchema,
  taskIndex: string | string[] | undefined
): string {
  const taskScope =
    taskIndex !== undefined ? resolveSubagentTaskScope(planData, { taskIndex }) : undefined;
  const contextTasks =
    taskScope?.tasks ??
    getAllIncompleteTasks(planData).map(({ taskIndex: index, task }) => ({
      index: index + 1,
      task,
    }));
  const taskDescriptions = contextTasks
    .map(({ index, task }) => {
      let description = `Task ${index}: ${task.title}`;
      if (task.description) {
        description += `\nDescription: ${task.description}`;
      }
      return description;
    })
    .join('\n\n');

  if (taskScope) {
    return `${taskScope.scopeNote}\n\n${taskDescriptions}`;
  }

  if (contextTasks.length === 0) {
    return 'All plan tasks are complete. Work only on the findings supplied in the instructions below.';
  }

  return `Available tasks:\n\n${taskDescriptions}`;
}

/**
 * Resolves and builds all data needed for a one-shot subagent provider run.
 * This function does not launch a provider or write command output.
 */
export async function prepareSubagentExecution(
  request: SubagentPreparationRequest
): Promise<PreparedSubagentExecution> {
  const config = await loadEffectiveConfig(request.configPath);
  const repoRoot =
    request.repositoryRoot ??
    (await resolveRepoRoot(request.configPath, (await getGitRoot()) || process.cwd()));
  const { plan: planData, planPath } = await resolvePlanByNumericId(request.planId, repoRoot);

  // Validate task scope before materialization, reference-artifact work, or
  // provider selection so invalid requests fail without those side effects.
  const taskContext = buildSubagentTaskContext(planData, request.taskIndex);
  const planFilePath = planPath ?? (await materializePlan(planData.id, repoRoot));
  const gitRoot = await getGitRoot(path.dirname(planFilePath));
  const useJj = await getUsingJj(gitRoot);
  const executor = resolveSubagentExecutor(request.executor, config);
  const selectedModel = resolveSubagentModel(request.agentType, executor, request.model, config);

  const referenceArtifactPaths = await tryMaterializeReferenceArtifactPathsForExecution(
    gitRoot,
    planData.id
  );

  const contextContent = await buildExecutionPromptWithoutSteps({
    executor: minimalExecutor as Executor,
    planData,
    planFilePath,
    baseDir: gitRoot,
    config,
    task: {
      // Batch mode renders only the description; the title is required by the
      // prompt-builder type but never emitted.
      title: 'Remaining Tasks',
      description: taskContext,
      files: [],
    },
    filePathPrefix: '@',
    includeCurrentPlanContext: true,
    batchMode: true,
    referenceArtifactPaths,
  });

  const roleDefinition = ROLE_DEFINITIONS[request.agentType];
  const customInstructions = await loadAgentInstructionsFor(
    roleDefinition.instructionKey,
    gitRoot,
    config
  );
  const inputText = await resolveSubagentInput(request.inputPolicy);

  const allInstructions = [customInstructions, inputText]
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n\n');
  const planIdLabel = planData.id?.toString() ?? 'unknown';
  const timEnvironment = buildTimWorkspaceCommandEnvironmentOptionsForPath(config, gitRoot, {
    planId: planData.id,
    planUuid: planData.uuid,
    planFilePath,
    branch: planData.branch,
  });
  const agentDefinition = roleDefinition.promptBuilder(
    contextContent,
    planIdLabel,
    allInstructions || undefined,
    selectedModel,
    { mode: 'report', useJj },
    request.promptContext
  );

  return {
    agentType: request.agentType,
    executor,
    model: selectedModel,
    plan: planData,
    planId: planData.id,
    planPath: planFilePath,
    gitRoot,
    useJj,
    prompt: agentDefinition.prompt,
    config,
    timEnvironment,
  };
}

/**
 * Starts a prepared one-shot provider execution and returns its completion
 * handle immediately.
 */
export function launchPreparedSubagent(prepared: PreparedSubagentExecution): SubagentLaunchHandle {
  const completion =
    prepared.executor === 'codex-cli' ? executeWithCodex(prepared) : executeWithClaude(prepared);

  return {
    executor: prepared.executor,
    completion: completion.then((finalMessage) => ({
      finalMessage,
      executor: prepared.executor,
    })),
  };
}

async function executeWithCodex(prepared: PreparedSubagentExecution): Promise<string> {
  const parsedModel = parseCodexModel(prepared.model);
  return executeCodexStep(prepared.prompt, prepared.gitRoot, prepared.config, {
    appServerMode: 'single-turn-with-steering',
    model: parsedModel.model,
    reasoningLevel: parsedModel.reasoningLevel,
    timEnvironment: prepared.timEnvironment,
  });
}

async function executeWithClaude(prepared: PreparedSubagentExecution): Promise<string> {
  const claudeCodeOptions =
    ((prepared.config.executors as Record<string, unknown> | undefined)?.['claude-code'] as
      | ClaudeCodeSubprocessOptions
      | undefined) ?? {};
  const isNoninteractive = process.env.TIM_NONINTERACTIVE === 'true';

  let lastResultText: string | undefined;
  let lastAssistantRaw: string | undefined;
  const timeoutMs = 30 * 60 * 1000;
  const result = await runClaudeSubprocess({
    prompt: prepared.prompt,
    cwd: prepared.gitRoot,
    timConfig: prepared.config,
    timEnvironment: prepared.timEnvironment,
    claudeCodeOptions,
    noninteractive: isNoninteractive,
    model: prepared.model,
    label: 'subagent',
    inactivityTimeoutMs: timeoutMs,
    extraAccessDirs:
      prepared.config.isUsingExternalStorage && prepared.config.externalRepositoryConfigDir
        ? [prepared.config.externalRepositoryConfigDir]
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

  if ((result.killedByTimeout || result.killedByInactivity) && !result.acceptedFinalResult) {
    throw new Error(`Claude subagent timed out after ${Math.round(timeoutMs / 60000)} minutes`);
  }

  if (result.exitCode !== 0 && !result.acceptedFinalResult) {
    throw new Error(`Claude subagent exited with non-zero exit code: ${result.exitCode}`);
  }

  const finalMessage = lastResultText || lastAssistantRaw;
  if (!finalMessage) {
    throw new Error('No final agent message found in Claude subagent output.');
  }

  return finalMessage;
}

async function resolveSubagentInput(policy: SubagentInputPolicy): Promise<string | undefined> {
  switch (policy.type) {
    case 'resolved':
      return policy.initialMessage;
    case 'orchestrator':
      return resolveOrchestratorInput(policy);
  }
}

function resolveSubagentModel(
  agentType: PreparedSubagentType,
  executorType: SubagentExecutor,
  cliModel: string | undefined,
  config: TimConfig
): string | undefined {
  if (cliModel?.trim()) {
    return cliModel;
  }

  const normalizedExecutor = normalizeSubagentExecutor(executorType);
  const roleDefinition = ROLE_DEFINITIONS[agentType];
  const configuredModel =
    config.subagents?.[roleDefinition.configKey]?.model?.[normalizedExecutor] ||
    config.subagents?.[roleDefinition.configKey]?.model?.[executorType as SubagentExecutorModelKey];
  if (configuredModel?.trim()) {
    return configuredModel;
  }

  if (normalizedExecutor === 'claude') {
    const claudeAgents = (config.executors as Record<string, unknown> | undefined)?.[
      'claude-code'
    ] as { agents?: Record<string, { model?: string } | undefined> } | undefined;
    const legacyModel = claudeAgents?.agents?.[roleDefinition.legacyClaudeModelKey]?.model;
    if (legacyModel?.trim()) {
      return legacyModel;
    }
  }

  return undefined;
}

function normalizeSubagentExecutor(executorType: SubagentExecutor): SubagentExecutorModelKey {
  return executorType === 'codex-cli' ? 'codex' : 'claude';
}

function resolveDefaultSubagentExecutor(config: TimConfig): SubagentExecutor {
  return config.defaultExecutor === 'codex-cli' || config.defaultExecutor === 'claude-code'
    ? config.defaultExecutor
    : 'claude-code';
}

function resolveSubagentExecutor(
  requestedExecutor: string | undefined,
  config: TimConfig
): SubagentExecutor {
  const executor = requestedExecutor?.trim() || resolveDefaultSubagentExecutor(config);
  if (executor !== 'codex-cli' && executor !== 'claude-code') {
    throw new Error(`Unsupported subagent executor: ${executor}`);
  }
  return executor;
}
