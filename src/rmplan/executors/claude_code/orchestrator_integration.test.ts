import { test, expect } from 'bun:test';
import { wrapWithOrchestration } from './orchestrator_prompt.ts';

test('wrapWithOrchestration integrates batch mode properly', () => {
  const contextContent = 'Test context content for implementation';
  const planId = 'test-plan-123';
  const planFilePath = '/path/to/test/plan.yml';

  // Test non-batch mode (default behavior)
  const nonBatchResult = wrapWithOrchestration(contextContent, planId);
  expect(nonBatchResult).toContain('multi-agent development workflow');
  expect(nonBatchResult).toContain(`rmplan-${planId}-implementer`);
  expect(nonBatchResult).not.toContain('BATCH TASK PROCESSING MODE');
  expect(nonBatchResult).not.toContain('@/path/to/test/plan.yml');

  // Test batch mode enabled
  const batchResult = wrapWithOrchestration(contextContent, planId, {
    batchMode: true,
    planFilePath,
  });
  
  expect(batchResult).toContain('BATCH TASK PROCESSING MODE');
  expect(batchResult).toContain('Analyze all provided tasks');
  expect(batchResult).toContain('Select a logical subset');
  expect(batchResult).toContain('Update the plan file');
  expect(batchResult).toContain('@/path/to/test/plan.yml');
  expect(batchResult).toContain('Task Selection Guidelines');
  expect(batchResult).toContain('Related functionality');
  expect(batchResult).toContain('Shared files');
  expect(batchResult).toContain('done: true');
  expect(batchResult).toContain(`rmplan-${planId}-implementer`);
  expect(batchResult).toContain('Test context content for implementation');

  // Test batch mode disabled explicitly
  const explicitNonBatchResult = wrapWithOrchestration(contextContent, planId, {
    batchMode: false,
    planFilePath,
  });
  
  expect(explicitNonBatchResult).not.toContain('BATCH TASK PROCESSING MODE');
  expect(explicitNonBatchResult).not.toContain('@/path/to/test/plan.yml');
  expect(explicitNonBatchResult).toContain(`rmplan-${planId}-implementer`);
});

test('wrapWithOrchestration handles missing planFilePath gracefully', () => {
  const contextContent = 'Test context';
  const planId = 'test-plan';

  // Test batch mode with missing planFilePath
  const result = wrapWithOrchestration(contextContent, planId, {
    batchMode: true,
    // planFilePath is undefined
  });

  expect(result).toContain('BATCH TASK PROCESSING MODE');
  expect(result).toContain('@PLAN_FILE_PATH_NOT_PROVIDED');
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
  expect(result).toContain('Task Selection Phase (Batch Mode Only)');
  expect(result).toContain('analyze all provided tasks and select a logical subset');
  expect(result).toContain('Document your selection and reasoning');
  expect(result).toContain('Focus on 2-5 related tasks');

  // Check for plan update instructions
  expect(result).toContain('Plan Update Phase (Batch Mode Only)');
  expect(result).toContain('After all selected tasks are successfully completed');
  expect(result).toContain('use the Edit tool to update the plan file');
  expect(result).toContain('Mark each completed task with `done: true`');
  
  // Check for batch mode guidelines
  expect(result).toContain('Be selective');
  expect(result).toContain("Don't attempt all tasks at once");
  expect(result).toContain('choose a reasonable subset that works well together');
});