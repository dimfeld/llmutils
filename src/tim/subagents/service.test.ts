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

  test('prepares every supported role with report-mode prompts and role instructions', async () => {
    mocks.getImplementerPrompt.mockReturnValue({
      name: 'implementer',
      prompt: 'implementer prepared prompt',
    });
    mocks.getTesterPrompt.mockReturnValue({ name: 'tester', prompt: 'tester prepared prompt' });
    mocks.getTddTestsPrompt.mockReturnValue({
      name: 'tdd-tests',
      prompt: 'tdd-tests prepared prompt',
    });

    const cases = [
      { agentType: 'implementer' as const, instructionKey: 'implementer' as const },
      { agentType: 'tester' as const, instructionKey: 'tester' as const },
      { agentType: 'tdd-tests' as const, instructionKey: 'tddTests' as const },
    ];

    for (const { agentType, instructionKey } of cases) {
      const prepared = await prepareSubagentExecution({
        agentType,
        planId: 42,
        executor: 'codex-cli',
        model: 'gpt-5-codex',
        initialMessage: `Initial ${agentType} message`,
      });

      expect(prepared.prompt).toBe(`${agentType} prepared prompt`);
      expect(mocks.loadAgentInstructionsFor).toHaveBeenLastCalledWith(
        instructionKey,
        gitRoot,
        prepared.config
      );
    }

    expect(mocks.getImplementerPrompt).toHaveBeenCalledWith(
      'prepared context',
      '42',
      'role instructions\n\nInitial implementer message',
      'gpt-5-codex',
      { mode: 'report', useJj: true }
    );
    expect(mocks.getTesterPrompt).toHaveBeenCalledWith(
      'prepared context',
      '42',
      'role instructions\n\nInitial tester message',
      'gpt-5-codex',
      { mode: 'report', useJj: true }
    );
    expect(mocks.getTddTestsPrompt).toHaveBeenCalledWith(
      'prepared context',
      '42',
      'role instructions\n\nInitial tdd-tests message',
      'gpt-5-codex',
      { mode: 'report', useJj: true }
    );
    expect(mocks.executeCodexStep).not.toHaveBeenCalled();
    expect(mocks.runClaudeSubprocess).not.toHaveBeenCalled();
  });

  test('uses initialMessage without reading input files or stdin', async () => {
    const prepared = await prepareSubagentExecution({
      agentType: 'implementer',
      planId: 42,
      executor: 'codex-cli',
      input: 'CLI input that must be ignored',
      inputFile: '/path/that/does/not/exist',
      initialMessage: 'Already resolved in-process input',
      fallbackToStdin: true,
    });

    expect(prepared.prompt).toContain('Already resolved in-process input');
    expect(prepared.prompt).not.toContain('CLI input that must be ignored');
    expect(mocks.executeCodexStep).not.toHaveBeenCalled();
  });

  test('passes materialized reference artifacts and plan environment to the prompt builder', async () => {
    mocks.resolvePlanByNumericId.mockResolvedValue({ plan, planPath: undefined });
    mocks.tryMaterializeReferenceArtifactPathsForExecution.mockResolvedValue([
      '/tmp/reference-artifact.md',
    ]);

    const prepared = await prepareSubagentExecution({
      agentType: 'tester',
      planId: 42,
      executor: 'codex-cli',
      initialMessage: 'Check the artifact.',
    });

    expect(mocks.materializePlan).toHaveBeenCalledWith(42, gitRoot);
    expect(mocks.tryMaterializeReferenceArtifactPathsForExecution).toHaveBeenCalledWith(
      gitRoot,
      42
    );
    expect(mocks.buildExecutionPromptWithoutSteps).toHaveBeenCalledWith(
      expect.objectContaining({
        planData: plan,
        planFilePath: planPath,
        baseDir: gitRoot,
        referenceArtifactPaths: ['/tmp/reference-artifact.md'],
        task: expect.objectContaining({ description: expect.stringContaining('Available tasks:') }),
      })
    );
    expect(mocks.buildTimWorkspaceCommandEnvironmentOptionsForPath).toHaveBeenCalledWith(
      prepared.config,
      gitRoot,
      {
        planId: 42,
        planUuid: plan.uuid,
        planFilePath: planPath,
        branch: plan.branch,
      }
    );
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

  test('propagates Codex provider failures through the completion promise', async () => {
    mocks.executeCodexStep.mockRejectedValueOnce(new Error('Codex provider failed'));
    const prepared = await prepareSubagentExecution({
      agentType: 'implementer',
      planId: 42,
      executor: 'codex-cli',
      initialMessage: 'Run once.',
    });

    const handle = launchPreparedSubagent(prepared);

    await expect(handle.completion).rejects.toThrow('Codex provider failed');
  });

  test('launches Claude with the legacy one-shot settings and prefers result text', async () => {
    const config = {
      defaultExecutor: 'claude-code',
      executors: { 'claude-code': { allowAllTools: true } },
      agents: {},
      isUsingExternalStorage: true,
      externalRepositoryConfigDir: '/tmp/external-repository-config',
    };
    mocks.loadEffectiveConfig.mockResolvedValue(config);
    mocks.runClaudeSubprocess.mockImplementationOnce(async (options: any) => {
      options.processFormattedMessages([
        { type: 'assistant', rawMessage: 'Assistant fallback' },
        { type: 'result', resultText: 'Accepted result text' },
      ]);
      return {
        acceptedFinalResult: false,
        exitCode: 0,
        killedByInactivity: false,
        killedByTimeout: false,
      };
    });

    const prepared = await prepareSubagentExecution({
      agentType: 'implementer',
      planId: 42,
      executor: 'claude-code',
      initialMessage: 'Run through Claude.',
    });
    const handle = launchPreparedSubagent(prepared);

    await expect(handle.completion).resolves.toEqual({
      finalMessage: 'Accepted result text',
      executor: 'claude-code',
    });
    expect(mocks.runClaudeSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: prepared.prompt,
        cwd: gitRoot,
        timConfig: config,
        timEnvironment: prepared.timEnvironment,
        claudeCodeOptions: { allowAllTools: true },
        model: prepared.model,
        label: 'subagent',
        inactivityTimeoutMs: 30 * 60 * 1000,
        extraAccessDirs: ['/tmp/external-repository-config'],
      })
    );
  });

  test('accepts a final Claude result when the provider exits nonzero or times out', async () => {
    mocks.loadEffectiveConfig.mockResolvedValue({
      defaultExecutor: 'claude-code',
      executors: {},
      agents: {},
    });
    mocks.runClaudeSubprocess.mockImplementationOnce(async (options: any) => {
      options.processFormattedMessages([
        { type: 'result', resultText: 'Completed before shutdown' },
      ]);
      return {
        acceptedFinalResult: true,
        exitCode: 17,
        killedByInactivity: true,
        killedByTimeout: true,
      };
    });

    const prepared = await prepareSubagentExecution({
      agentType: 'tester',
      planId: 42,
      executor: 'claude-code',
      initialMessage: 'Test the change.',
    });

    await expect(launchPreparedSubagent(prepared).completion).resolves.toEqual({
      finalMessage: 'Completed before shutdown',
      executor: 'claude-code',
    });
  });

  test('rejects Claude completion when no final result or assistant message exists', async () => {
    mocks.loadEffectiveConfig.mockResolvedValue({
      defaultExecutor: 'claude-code',
      executors: {},
      agents: {},
    });
    mocks.runClaudeSubprocess.mockResolvedValueOnce({
      acceptedFinalResult: false,
      exitCode: 0,
      killedByInactivity: false,
      killedByTimeout: false,
    });

    const prepared = await prepareSubagentExecution({
      agentType: 'tdd-tests',
      planId: 42,
      executor: 'claude-code',
      initialMessage: 'Write tests.',
    });

    await expect(launchPreparedSubagent(prepared).completion).rejects.toThrow(
      'No final agent message found in Claude subagent output.'
    );
  });
});
