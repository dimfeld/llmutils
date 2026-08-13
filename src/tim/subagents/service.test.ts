import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as path from 'node:path';
import { makeSubagentPlanFixture } from '../commands/subagent.test-helpers.js';
import type { PlanSchema } from '../planSchema.js';
import { launchPreparedSubagent, prepareSubagentExecution } from './service.js';

const mocks = vi.hoisted(() => ({
  loadEffectiveConfig: vi.fn(),
  resolveRepoRoot: vi.fn(),
  resolvePlanByNumericId: vi.fn(),
  materializePlan: vi.fn(),
  getGitRoot: vi.fn(),
  getUsingJj: vi.fn(),
  buildExecutionPromptWithoutSteps: vi.fn(),
  getImplementerPrompt: vi.fn(),
  getTesterPrompt: vi.fn(),
  getTddTestsPrompt: vi.fn(),
  loadAgentInstructionsFor: vi.fn(),
  tryMaterializeReferenceArtifactPathsForExecution: vi.fn(),
  buildTimWorkspaceCommandEnvironmentOptionsForPath: vi.fn(),
  executeCodexStep: vi.fn(),
  runClaudeSubprocess: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: mocks.loadEffectiveConfig,
}));
vi.mock('../plan_repo_root.js', () => ({
  resolveRepoRoot: mocks.resolveRepoRoot,
}));
vi.mock('../plans.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plans.js')>()),
  resolvePlanByNumericId: mocks.resolvePlanByNumericId,
}));
vi.mock('../plan_materialize.js', () => ({
  materializePlan: mocks.materializePlan,
}));
vi.mock('../../common/git.js', () => ({
  getGitRoot: mocks.getGitRoot,
  getUsingJj: mocks.getUsingJj,
}));
vi.mock('../prompt_builder.js', () => ({
  buildExecutionPromptWithoutSteps: mocks.buildExecutionPromptWithoutSteps,
}));
vi.mock('../executors/claude_code/agent_prompts.js', () => ({
  getImplementerPrompt: mocks.getImplementerPrompt,
  getTesterPrompt: mocks.getTesterPrompt,
  getTddTestsPrompt: mocks.getTddTestsPrompt,
}));
vi.mock('../executors/codex_cli/agent_helpers.js', () => ({
  loadAgentInstructionsFor: mocks.loadAgentInstructionsFor,
}));
vi.mock('../reference_artifacts.js', () => ({
  tryMaterializeReferenceArtifactPathsForExecution:
    mocks.tryMaterializeReferenceArtifactPathsForExecution,
}));
vi.mock('../environment_options.js', () => ({
  buildTimWorkspaceCommandEnvironmentOptionsForPath:
    mocks.buildTimWorkspaceCommandEnvironmentOptionsForPath,
}));
vi.mock('../executors/codex_cli/codex_runner.js', () => ({
  executeCodexStep: mocks.executeCodexStep,
}));
vi.mock('../executors/claude_code/run_claude_subprocess.js', () => ({
  runClaudeSubprocess: mocks.runClaudeSubprocess,
}));

describe('reusable subagent service', () => {
  let plan: PlanSchema;
  const gitRoot = '/tmp/subagent-service-repository';
  const planPath = path.join(gitRoot, '.tim', 'plans', '42.plan.md');

  beforeEach(() => {
    vi.clearAllMocks();
    plan = makeSubagentPlanFixture();
    mocks.loadEffectiveConfig.mockResolvedValue({
      defaultExecutor: 'codex-cli',
      executors: {},
      agents: {},
    });
    mocks.resolveRepoRoot.mockResolvedValue(gitRoot);
    mocks.resolvePlanByNumericId.mockResolvedValue({ plan, planPath });
    mocks.materializePlan.mockResolvedValue(planPath);
    mocks.getGitRoot.mockResolvedValue(gitRoot);
    mocks.getUsingJj.mockResolvedValue(true);
    mocks.buildExecutionPromptWithoutSteps.mockResolvedValue('prepared context');
    mocks.getImplementerPrompt.mockImplementation(
      (context: string, planId: string, customInstructions: string | undefined) => ({
        name: 'implementer',
        prompt: [context, planId, customInstructions].filter(Boolean).join('|'),
      })
    );
    mocks.getTesterPrompt.mockReturnValue({ name: 'tester', prompt: 'tester prompt' });
    mocks.getTddTestsPrompt.mockReturnValue({ name: 'tdd-tests', prompt: 'tdd prompt' });
    mocks.loadAgentInstructionsFor.mockResolvedValue('role instructions');
    mocks.tryMaterializeReferenceArtifactPathsForExecution.mockResolvedValue([]);
    mocks.buildTimWorkspaceCommandEnvironmentOptionsForPath.mockReturnValue({
      planId: plan.id,
      planUuid: plan.uuid,
      planFilePath: planPath,
      branch: plan.branch,
    });
    mocks.executeCodexStep.mockResolvedValue('Codex finished');
  });

  test('prepares without launching a provider or reading stdin', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    const prepared = await prepareSubagentExecution({
      agentType: 'implementer',
      planId: 42,
      executor: 'codex-cli',
      initialMessage: 'Use the initial message.',
    });

    expect(prepared.executor).toBe('codex-cli');
    expect(prepared.prompt).toBe(
      'prepared context|42|role instructions\n\nUse the initial message.'
    );
    expect(prepared.gitRoot).toBe(gitRoot);
    expect(prepared.useJj).toBe(true);
    expect(prepared.timEnvironment).toEqual(expect.objectContaining({ planId: 42 }));
    expect(mocks.executeCodexStep).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();

    consoleLog.mockRestore();
  });

  test('does not materialize or launch when task scope validation fails', async () => {
    plan = {
      ...plan,
      tasks: [
        { title: 'Completed task', description: 'Done', done: true },
        { title: 'Pending task', description: 'Open', done: false },
      ],
    };
    mocks.resolvePlanByNumericId.mockResolvedValue({ plan, planPath: undefined });

    await expect(
      prepareSubagentExecution({
        agentType: 'tester',
        planId: 42,
        executor: 'codex-cli',
        taskIndex: '1',
      })
    ).rejects.toThrow('Already completed task indexes: 1');

    expect(mocks.materializePlan).not.toHaveBeenCalled();
    expect(mocks.tryMaterializeReferenceArtifactPathsForExecution).not.toHaveBeenCalled();
    expect(mocks.executeCodexStep).not.toHaveBeenCalled();
  });

  test('returns a provider-neutral one-shot completion handle', async () => {
    const prepared = await prepareSubagentExecution({
      agentType: 'implementer',
      planId: 42,
      executor: 'codex-cli',
      initialMessage: 'Run once.',
    });

    const handle = launchPreparedSubagent(prepared);

    expect(handle.executor).toBe('codex-cli');
    expect(Object.keys(handle).sort()).toEqual(['completion', 'executor']);
    await expect(handle.completion).resolves.toEqual({
      finalMessage: 'Codex finished',
      executor: 'codex-cli',
    });
    expect(mocks.executeCodexStep).toHaveBeenCalledWith(
      prepared.prompt,
      gitRoot,
      prepared.config,
      expect.objectContaining({
        appServerMode: 'single-turn-with-steering',
        timEnvironment: prepared.timEnvironment,
      })
    );
  });
});
