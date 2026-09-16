import * as path from 'node:path';
import { loadEffectiveConfig } from '../configLoader.js';
import { appendQualityGuidance } from '../quality.js';
import { resolvePlanByNumericId } from '../plans.js';
import { getAllIncompleteTasks } from '../plans/find_next.js';
import { resolveSubagentTaskScope } from '../plans/task_scope.js';
import { buildExecutionPromptWithoutSteps } from '../prompt_builder.js';
import {
  getAdvisorPrompt,
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
import { resolveAdvisorConfiguration } from './advisor.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { materializePlan } from '../plan_materialize.js';
import { buildTimWorkspaceCommandEnvironmentOptionsForPath } from '../environment_options.js';
import { tryMaterializeReferenceArtifactPathsForExecution } from '../reference_artifacts.js';
import type {
  PlanlessAdvisorPreparationRequest,
  PreparedPlanlessSubagentExecution,
  PreparedSubagentExecution,
  PreparedSubagentExecutionBase,
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
type SubagentConfigKey = 'implementer' | 'tester' | 'tddTests' | 'reviewer' | 'advisor';
type SubagentInstructionKey = 'implementer' | 'tester' | 'tddTests' | 'reviewer' | 'advisor';

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
  advisor: {
    instructionKey: 'advisor',
    configKey: 'advisor',
    legacyClaudeModelKey: 'advisor',
    promptBuilder: getAdvisorPrompt,
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
  const difficulty = normalizeSubagentDifficulty(request.difficulty);
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
  const executor = resolveSubagentExecutor(request.agentType, request.executor, config);
  const selectedModel = resolveSubagentModel(
    request.agentType,
    executor,
    request.model,
    config,
    difficulty
  );

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
 * Resolves and builds everything needed for an advisor consultation that has no
 * plan behind it.
 *
 * The advisor is read-only and reads the codebase for itself, so a question
 * that arises before any plan exists — during planning, most often — can still
 * reach it. Executor, model, and custom instructions resolve exactly as they do
 * for a plan-bound advisor run; only the plan context is replaced by the
 * repository itself.
 */
export async function preparePlanlessAdvisorExecution(
  request: PlanlessAdvisorPreparationRequest
): Promise<PreparedPlanlessSubagentExecution> {
  const difficulty = normalizeSubagentDifficulty(request.difficulty);
  const config = await loadEffectiveConfig(request.configPath);
  const repoRoot =
    request.repositoryRoot ??
    (await resolveRepoRoot(request.configPath, (await getGitRoot()) || process.cwd()));
  const gitRoot = (await getGitRoot(repoRoot)) || repoRoot;
  const useJj = await getUsingJj(gitRoot);
  const executor = resolveSubagentExecutor('advisor', request.executor, config);
  const selectedModel = resolveSubagentModel(
    'advisor',
    executor,
    request.model,
    config,
    difficulty
  );

  const customInstructions = await loadAgentInstructionsFor('advisor', gitRoot, config);
  const inputText = await resolveSubagentInput(request.inputPolicy);
  const allInstructions = [customInstructions, inputText]
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n\n');

  const contextContent = appendQualityGuidance(
    buildPlanlessAdvisorContext(gitRoot),
    config.quality
  );
  const timEnvironment = buildTimWorkspaceCommandEnvironmentOptionsForPath(config, gitRoot);
  const agentDefinition = getAdvisorPrompt(
    contextContent,
    undefined,
    allInstructions || undefined,
    selectedModel,
    { mode: 'report', useJj }
  );

  return {
    agentType: 'advisor',
    executor,
    model: selectedModel,
    gitRoot,
    useJj,
    prompt: agentDefinition.prompt,
    config,
    timEnvironment,
  };
}

/**
 * Builds the context section used when the advisor runs without a plan.
 *
 * It replaces the plan and task sections of a normal subagent prompt, and says
 * plainly that the repository plus the supplied question are the whole context,
 * so the advisor does not go looking for a plan that does not exist.
 */
function buildPlanlessAdvisorContext(gitRoot: string): string {
  return `This consultation is not attached to a tim plan. There is no plan file, no task list, and no implementation in progress to read.

The repository at \`${gitRoot}\` and the question in the instructions below are the entire context. Investigate the code, tests, configuration, and history directly to ground your answer, and answer the question that was asked rather than assuming a plan or task exists behind it.
`;
}

/**
 * Validates the requested difficulty before any other preparation work.
 *
 * The parameter is typed as a string because the value reaches here straight
 * from the CLI, where the declared union is not enforced at runtime.
 */
function normalizeSubagentDifficulty(difficulty: string | undefined): 'low' | 'high' {
  const resolved = difficulty ?? 'high';
  if (resolved !== 'low' && resolved !== 'high') {
    throw new Error(`Invalid subagent difficulty: ${resolved}. Expected low or high.`);
  }
  return resolved;
}

/**
 * Starts a prepared one-shot provider execution and returns its completion
 * handle immediately.
 */
export function launchPreparedSubagent(
  prepared: PreparedSubagentExecutionBase
): SubagentLaunchHandle {
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

async function executeWithCodex(prepared: PreparedSubagentExecutionBase): Promise<string> {
  const parsedModel = parseCodexModel(prepared.model);
  return executeCodexStep(prepared.prompt, prepared.gitRoot, prepared.config, {
    appServerMode: 'single-turn-with-steering',
    model: parsedModel.model,
    reasoningLevel: parsedModel.reasoningLevel,
    timEnvironment: prepared.timEnvironment,
  });
}

async function executeWithClaude(prepared: PreparedSubagentExecutionBase): Promise<string> {
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
  config: TimConfig,
  difficulty: 'low' | 'high'
): string | undefined {
  if (cliModel?.trim()) {
    return cliModel;
  }

  const normalizedExecutor = normalizeSubagentExecutor(executorType);
  const roleDefinition = ROLE_DEFINITIONS[agentType];
  const roleConfig = config.subagents?.[roleDefinition.configKey];
  const difficultyModel =
    roleConfig && 'modelByDifficulty' in roleConfig
      ? roleConfig.modelByDifficulty?.[difficulty]?.[normalizedExecutor]
      : undefined;
  if (difficultyModel?.trim()) {
    return difficultyModel;
  }
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
  agentType: PreparedSubagentType,
  requestedExecutor: string | undefined,
  config: TimConfig
): SubagentExecutor {
  const executor =
    requestedExecutor?.trim() ||
    (agentType === 'advisor' ? resolveAdvisorConfiguration(config)?.executor : undefined) ||
    resolveDefaultSubagentExecutor(config);
  if (executor !== 'codex-cli' && executor !== 'claude-code') {
    throw new Error(`Unsupported subagent executor: ${executor}`);
  }
  return executor;
}
