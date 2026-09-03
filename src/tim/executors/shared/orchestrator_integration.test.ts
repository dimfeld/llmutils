import { test, expect } from 'vitest';
import {
  wrapWithOrchestration,
  wrapWithOrchestrationSimple,
  wrapWithOrchestrationTdd,
} from './orchestrator_prompt.ts';
import { wrapForExecutionMode } from './orchestration_wrapper.ts';

test('wrapWithOrchestration integrates batch mode properly', () => {
  const contextContent = 'Test context content for implementation';
  const planId = 'test-plan-123';
  const planFilePath = '/path/to/test/plan.yml';

  // Test non-batch mode (default behavior)
  const nonBatchResult = wrapWithOrchestration(contextContent, planId);
  expect(nonBatchResult).toContain('multi-agent development workflow');
  expect(nonBatchResult).toContain(`tim subagent implementer`);
  expect(nonBatchResult).not.toContain('BATCH TASK PROCESSING MODE');
  expect(nonBatchResult).not.toContain('@/path/to/test/plan.yml');

  // Test batch mode enabled
  const batchResult = wrapWithOrchestration(contextContent, planId, {
    batchMode: true,
    planFilePath,
  });

  expect(batchResult).toContain('# Batch Task Processing Mode');
  expect(batchResult).toContain('Analyze all provided tasks');
  expect(batchResult).toContain('Select a logical subset');
  expect(batchResult).toContain('Update the plan file');
  expect(batchResult).toContain('@/path/to/test/plan.yml');
  expect(batchResult).toContain('Task Selection Guidelines');
  expect(batchResult).toContain('Related functionality');
  expect(batchResult).toContain('Shared files');
  expect(batchResult).toContain('done: true');
  expect(batchResult).toContain(`tim subagent implementer`);
  expect(batchResult).toContain('Test context content for implementation');

  // Test batch mode disabled explicitly
  const explicitNonBatchResult = wrapWithOrchestration(contextContent, planId, {
    batchMode: false,
    planFilePath,
  });

  expect(explicitNonBatchResult).not.toContain('# Batch Task Processing Mode');
  expect(explicitNonBatchResult).toContain('@/path/to/test/plan.yml');
  expect(explicitNonBatchResult).toContain(`tim subagent implementer`);
});

test('wrapWithOrchestration handles missing planFilePath gracefully', () => {
  const contextContent = 'Test context';
  const planId = 'test-plan';

  // Test batch mode with missing planFilePath
  const result = wrapWithOrchestration(contextContent, planId, {
    batchMode: true,
    // planFilePath is undefined
  });

  expect(result).toContain('# Batch Task Processing Mode');
  expect(result).toContain('PLAN_FILE_PATH_NOT_PROVIDED');
});

test('wrapWithOrchestration includes batch mode workflow instructions', () => {
  const contextContent = 'Test implementation task';
  const planId = 'workflow-test';
  const planFilePath = '/test/workflow.plan.yml';

  const result = wrapWithOrchestration(contextContent, planId, {
    batchMode: true,
    planFilePath,
  });

  // Check for batch-specific workflow phases
  expect(result).toContain('1. **Task Selection Phase**');
  expect(result).toContain('analyze all provided tasks and select a logical subset to work on');
  expect(result).toContain('Document your selection and reasoning');
  expect(result).toContain('Focus on 2-5 related tasks');

  // Check for plan update instructions
  expect(result).toContain('4. **Update the plan file**');
  expect(result).toContain('5. Mark the tasks done.');
  expect(result).toContain('## Plan File Updates');
  expect(result).toContain('edit the plan file');
  expect(result).toContain(
    'Only mark tasks as `done: true` after they have been successfully implemented'
  );

  // Check for batch mode guidelines
  expect(result).toContain('**Be selective**');
  expect(result).toContain("Don't attempt all tasks at once");
  expect(result).toContain('choose a reasonable subset that works well together');
});

test.each([
  { provider: 'Claude', useAtPrefix: true },
  { provider: 'Codex', useAtPrefix: false },
])('$provider receives the same enabled collaborative workflow semantics', ({ useAtPrefix }) => {
  for (const mode of ['normal', 'simple', 'tdd'] as const) {
    const prompt = wrapForExecutionMode(mode, 'provider-neutral context', '421', {
      agentMessagingEnabled: true,
      batchMode: mode === 'tdd',
      simpleMode: mode === 'simple',
      subagentExecutor: 'dynamic',
      useAtPrefix,
    });

    expect(prompt).toContain('StartTimAgent');
    expect(prompt).toContain('ListTimAgents');
    expect(prompt).toContain('SendTimAgentMessage');
    expect(prompt).toContain('make a result-bearing `Tim` tool call');
    expect(prompt).toContain('put its final status in the FinishTimAgent message');
    expect(prompt).toContain('A plain assistant response without either tool call');
    expect(prompt).toContain('StopTimAgent');
    expect(prompt).toContain('FinishTimAgent is self-only');
    expect(prompt).toContain('claude-code');
    expect(prompt).toContain('codex-cli');
    expect(prompt).toContain('one working directory');
    expect(prompt).toContain('tim review 421 --print --output-file <output_path>');
    expect(prompt).not.toMatch(/tim subagent (implementer|tester|tdd-tests|reviewer)/);
  }
});

test('the Claude and Codex prompt compositions differ only in provider file-prefix semantics', () => {
  const commonOptions = {
    agentMessagingEnabled: true,
    batchMode: true,
    planFilePath: '/path/to/plan.md',
    subagentExecutor: 'claude-code' as const,
  };
  const claudePrompt = wrapForExecutionMode('normal', 'context', '421', {
    ...commonOptions,
    useAtPrefix: true,
  });
  const codexPrompt = wrapForExecutionMode('normal', 'context', '421', {
    ...commonOptions,
    useAtPrefix: false,
  });

  expect(claudePrompt.replaceAll('@/path/to/plan.md', '/path/to/plan.md')).toBe(codexPrompt);
});

test.each([
  ['normal', wrapWithOrchestration],
  ['simple', wrapWithOrchestrationSimple],
  ['tdd', wrapWithOrchestrationTdd],
] as const)('$s retains one-shot delegation when messaging is disabled', (mode, build) => {
  const prompt = build('provider-neutral context', '421', {
    agentMessagingEnabled: false,
    batchMode: mode === 'tdd',
  });

  expect(prompt).not.toContain('StartTimAgent');
  expect(prompt).not.toContain('ListTimAgents');
  expect(prompt).not.toContain('SendTimAgentMessage');
  expect(prompt).not.toContain('StopTimAgent');
  expect(prompt).not.toContain('FinishTimAgent');
  expect(prompt).toContain('tim subagent');
});
