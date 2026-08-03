import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getImplementerPrompt,
  getTddTestsPrompt,
  getTesterPrompt,
} from '../executors/claude_code/agent_prompts.js';
import { buildExecutionPromptWithoutSteps } from '../prompt_builder.js';
import { buildSubagentTaskContext } from './subagent.js';
import type { PlanSchema } from '../planSchema.js';
import type { TimConfig } from '../configSchema.js';
import type { Executor } from '../executors/types.js';

// Keep the real module and override only getGitRoot. Importing ./subagent.js
// pulls in getUsingJj too, so a factory listing single exports would leave the
// next test that drives handleSubagentCommand failing on a missing mock rather
// than on its own assertion.
let mockGitRoot = '';
vi.mock('../../common/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common/git.js')>()),
  getGitRoot: vi.fn(() => mockGitRoot),
}));

describe('subagent prompt function correctness', () => {
  test('getImplementerPrompt with mode: report includes progress reporting', () => {
    const result = getImplementerPrompt('test context', 42, 'custom instructions', undefined, {
      mode: 'report',
    });

    expect(result.name).toBe('implementer');
    expect(result.prompt).toContain('test context');
    expect(result.prompt).toContain('custom instructions');
    expect(result.prompt).toContain('Report progress, decisions, and blockers to the orchestrator');
    expect(result.prompt).toContain('Do NOT update the plan file directly');
  });

  test('getTesterPrompt with mode: report includes progress reporting', () => {
    const result = getTesterPrompt('test context', 42, 'custom instructions', undefined, {
      mode: 'report',
    });

    expect(result.name).toBe('tester');
    expect(result.prompt).toContain('test context');
    expect(result.prompt).toContain('custom instructions');
    expect(result.prompt).toContain('Report progress, decisions, and blockers to the orchestrator');
  });

  test('getTddTestsPrompt with mode: report includes TDD-first guidance', () => {
    const result = getTddTestsPrompt('test context', 42, 'custom instructions', undefined, {
      mode: 'report',
    });

    expect(result.name).toBe('tdd-tests');
    expect(result.prompt).toContain('test context');
    expect(result.prompt).toContain('custom instructions');
    expect(result.prompt).toContain('tests should initially FAIL');
    expect(result.prompt).toContain('Report progress, decisions, and blockers to the orchestrator');
  });

  test('getImplementerPrompt custom instructions appear in dedicated section', () => {
    const result = getImplementerPrompt('', 42, 'My custom instruction', undefined, {
      mode: 'report',
    });

    expect(result.prompt).toContain('## Custom Instructions');
    expect(result.prompt).toContain('My custom instruction');
  });

  test('getImplementerPrompt without custom instructions omits section', () => {
    const result = getImplementerPrompt('', 42, undefined, undefined, {
      mode: 'report',
    });

    expect(result.prompt).not.toContain('## Custom Instructions');
  });

  test('getTesterPrompt model is passed through', () => {
    const result = getTesterPrompt('', 42, undefined, 'sonnet', {
      mode: 'report',
    });

    expect(result.model).toBe('sonnet');
  });

  test('getImplementerPrompt includes FAILED_PROTOCOL_INSTRUCTIONS', () => {
    const result = getImplementerPrompt('', 42, undefined, undefined, {
      mode: 'report',
    });

    expect(result.prompt).toContain('Failure Protocol');
    expect(result.prompt).toContain('FAILED:');
  });

  test('getTesterPrompt includes FAILED_PROTOCOL_INSTRUCTIONS', () => {
    const result = getTesterPrompt('', 42, undefined, undefined, {
      mode: 'report',
    });

    expect(result.prompt).toContain('Failure Protocol');
    expect(result.prompt).toContain('FAILED:');
  });

  test('getImplementerPrompt skills include using-tim', () => {
    const result = getImplementerPrompt('', 42, undefined, undefined, {
      mode: 'report',
    });

    expect(result.skills).toContain('using-tim');
  });

  test('all prompt functions produce skills with using-tim', () => {
    const impl = getImplementerPrompt('ctx', 1, undefined, undefined, { mode: 'report' });
    const tdd = getTddTestsPrompt('ctx', 1, undefined, undefined, { mode: 'report' });
    const tester = getTesterPrompt('ctx', 1, undefined, undefined, { mode: 'report' });

    expect(impl.skills).toContain('using-tim');
    expect(tdd.skills).toContain('using-tim');
    expect(tester.skills).toContain('using-tim');
  });
});

describe('allowed tools in getDefaultAllowedTools', () => {
  test('Bash(tim subagent:*) is in the default allowed tools list', async () => {
    const { getDefaultAllowedTools } =
      await import('../executors/claude_code/run_claude_subprocess.ts');
    const tools = getDefaultAllowedTools();
    expect(tools).toContain('Bash(tim subagent:*)');
  });

  test('Bash(tim subagent:*) coexists with other tim tools', async () => {
    const { getDefaultAllowedTools } =
      await import('../executors/claude_code/run_claude_subprocess.ts');
    const tools = getDefaultAllowedTools();

    expect(tools).toContain('Bash(tim add:*)');
    expect(tools).toContain('Bash(tim review:*)');
    expect(tools).toContain('Bash(tim set-task-done:*)');
    expect(tools).toContain('Bash(tim subagent:*)');
  });
});

/**
 * Exercises the real task-context composition that handleSubagentCommand
 * performs: the exported buildSubagentTaskContext feeding
 * buildExecutionPromptWithoutSteps. Only getGitRoot is stubbed (matching
 * prompt_builder.test.ts); everything else runs unmocked, so a regression in
 * the real scoping logic, the intro wording, or the prompt builder shows up
 * here rather than passing against a copy of the production glue.
 */
describe('subagent task-context prompt shape', () => {
  let tempDir: string;
  let planFilePath: string;
  const config: TimConfig = { paths: { tasks: 'tasks' } };
  const executor: Executor = { execute: vi.fn(async () => {}) } as unknown as Executor;

  function makePlan(): PlanSchema {
    return {
      id: 42,
      title: 'Scope test plan',
      goal: 'Verify task scoping',
      tasks: [
        { title: 'Implement the widget', description: 'Write the widget code', done: false },
        { title: 'Deploy the widget', description: 'Ship it to prod', done: true },
        { title: 'Test the widget', description: 'Write tests for the widget code', done: false },
      ],
    };
  }

  /**
   * Runs the same two production steps handleSubagentCommand performs: the real
   * exported task-context builder, feeding the real prompt builder.
   */
  async function buildContext(
    planData: PlanSchema,
    taskIndex?: string | string[]
  ): Promise<string> {
    const taskContext = buildSubagentTaskContext(planData, taskIndex);

    return buildExecutionPromptWithoutSteps({
      executor,
      planData,
      planFilePath,
      baseDir: tempDir,
      config,
      task: { title: 'Remaining Tasks', description: taskContext, files: [] },
      filePathPrefix: '@',
      includeCurrentPlanContext: true,
      batchMode: true,
    });
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-subagent-test-'));
    mockGitRoot = tempDir;
    planFilePath = path.join(tempDir, '42-scope-test.plan.md');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('without --task-index, all incomplete tasks appear under the unscoped intro', async () => {
    const result = await buildContext(makePlan());

    expect(result).toContain('## Remaining Tasks');
    expect(result).toContain('Available tasks:');
    expect(result).toContain('Task 1: Implement the widget');
    expect(result).toContain('Task 3: Test the widget');
    expect(result).not.toContain('Deploy the widget');
    expect(result).not.toContain('scoped to exactly these plan tasks');
  });

  test('with --task-index, only the scoped task appears with the scoped intro', async () => {
    const result = await buildContext(makePlan(), '3');

    expect(result).toContain('## Remaining Tasks');
    expect(result).toContain('scoped to exactly these plan tasks: 3');
    expect(result).toContain('Other plan work is out of scope');
    expect(result).toContain('Task 3: Test the widget');
    expect(result).not.toContain('Available tasks:');
    expect(result).not.toContain('Implement the widget');
    expect(result).not.toContain('Deploy the widget');
  });

  test('with no incomplete tasks and no --task-index, states the plan is complete instead of a bare header', async () => {
    const plan: PlanSchema = {
      id: 42,
      title: 'Scope test plan',
      goal: 'Verify task scoping',
      tasks: [
        { title: 'Implement the widget', description: 'Write the widget code', done: true },
        { title: 'Test the widget', description: 'Write tests for the widget code', done: true },
      ],
    };

    const result = await buildContext(plan);

    expect(result).toContain('## Remaining Tasks');
    expect(result).toContain('All plan tasks are complete.');
    expect(result).toContain('Work only on the findings supplied in the instructions below.');
    expect(result).not.toContain('Available tasks:');
    expect(result).not.toContain('Implement the widget');
  });
});
