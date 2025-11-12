import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDefaultConfig } from '../configSchema.js';
import type { PlanSchema } from '../planSchema.js';
import { writePlanFile, readPlanFile, clearPlanCache, readAllPlans } from '../plans.js';
import { resolvePlan } from '../plan_display.js';
import {
  appendResearchParameters,
  generateTasksParameters,
  getPlanParameters,
  listReadyPlansParameters,
  managePlanTaskParameters,
  mcpManagePlanTask,
  loadGeneratePrompt,
  loadPlanPrompt,
  loadQuestionsPrompt,
  loadResearchPrompt,
  type GenerateModeRegistrationContext,
} from './generate_mode.js';
import { loadCompactPlanPrompt } from './prompts/compact_plan.js';
import { mcpGetPlan } from '../commands/show.js';
import { mcpUpdatePlanTasks, mcpAppendResearch } from './generate_mode.js';
import { mcpListReadyPlans } from '../commands/ready.js';

const basePlan: PlanSchema = {
  id: 99999,
  title: 'Test Plan',
  goal: 'Ship a high-quality feature',
  details: 'Initial details about the plan.',
  status: 'pending' as const,
  priority: 'medium' as const,
  tasks: [],
};

describe('rmplan MCP generate mode helpers', () => {
  let tmpDir: string;
  let planPath: string;
  let context: GenerateModeRegistrationContext;

  beforeEach(async () => {
    clearPlanCache();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rmplan-mcp-'));
    planPath = path.join(tmpDir, '99999-test.plan.md');
    await writePlanFile(planPath, basePlan);

    const config = getDefaultConfig();
    config.paths = { tasks: tmpDir };

    context = {
      config,
      configPath: undefined,
      gitRoot: tmpDir,
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    clearPlanCache();
  });

  test('loadResearchPrompt returns plan context with research template', async () => {
    const prompt = await loadResearchPrompt({ plan: planPath }, context);
    const message = prompt.messages[0]?.content;
    expect(message?.text).toContain('Test Plan');
    expect(message?.text).toContain('Follow this exact template');
    expect(message?.text).toContain('### Summary');
  });

  test('loadQuestionsPrompt encourages iterative questioning', async () => {
    const prompt = await loadQuestionsPrompt({ plan: planPath }, context);
    const message = prompt.messages[0]?.content;
    expect(message?.text).toContain('Ask one concise, high-impact question');
    expect(message?.text).toContain('Initial details about the plan.');
  });

  test('loadGeneratePrompt returns plan context with generation instructions', async () => {
    const prompt = await loadGeneratePrompt({ plan: planPath }, context);
    const message = prompt.messages[0]?.content;
    expect(message?.text).toContain('Test Plan');
    expect(message?.text).toContain('generate a detailed implementation plan');
    expect(message?.text).toContain('update-plan-tasks tool');
    expect(message?.text).toContain('Break the project into phases');
  });

  test('loadPlanPrompt returns plan details and wait instruction', async () => {
    const prompt = await loadPlanPrompt({ plan: planPath }, context);
    const message = prompt.messages[0]?.content;
    expect(message?.text).toContain('Plan ID: 99999');
    expect(message?.text).toContain('Test Plan');
    expect(message?.text).toContain('Wait for your human collaborator');
  });

  test('loadCompactPlanPrompt builds compaction instructions for eligible plans', async () => {
    const donePlan: PlanSchema = {
      ...basePlan,
      status: 'done',
      updatedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      details: `${basePlan.details}\n\n## Research\n- Deep dive`,
    };
    await writePlanFile(planPath, donePlan);

    const prompt = await loadCompactPlanPrompt({ plan: planPath }, context);
    const message = prompt.messages[0]?.content;
    expect(message?.text).toContain('You are an expert technical editor');
    expect(message?.text).toContain('Read the plan file at:');
    expect(message?.text).toContain('Compact the plan by editing the file directly');
    expect(message?.text).toContain('let your human collaborator know the compaction is complete');
  });

  test('loadCompactPlanPrompt rejects plans that are not completed', async () => {
    await expect(loadCompactPlanPrompt({ plan: planPath }, context)).rejects.toThrow(
      'Only done, cancelled, or deferred plans can be compacted.'
    );
  });

  test('loadCompactPlanPrompt requires a plan identifier', async () => {
    await expect(loadCompactPlanPrompt({ plan: '   ' }, context)).rejects.toThrow(
      'Plan ID or file path is required to build a compaction prompt.'
    );
  });

  test('loadCompactPlanPrompt appends an age warning when plan is younger than minimum threshold', async () => {
    const recentPlan: PlanSchema = {
      ...basePlan,
      status: 'done',
      updatedAt: new Date().toISOString(),
      details: `${basePlan.details}\n\n## Research\n- Recent notes`,
    };
    await writePlanFile(planPath, recentPlan);

    context.config.compaction = { minimumAgeDays: 60 };

    const prompt = await loadCompactPlanPrompt({ plan: planPath }, context);
    const messageText = prompt.messages[0]?.content?.text ?? '';
    expect(messageText).toContain('Minimum age threshold: 60 days');
    expect(messageText).toContain('Warning: This plan was last updated');
    expect(messageText).toContain('let your human collaborator know the compaction is complete');
  });

  test('loadCompactPlanPrompt respects configured minimum age when no warning is needed', async () => {
    const olderPlan: PlanSchema = {
      ...basePlan,
      status: 'done',
      updatedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      details: `${basePlan.details}\n\n## Research\n- Long-running work`,
    };
    await writePlanFile(planPath, olderPlan, { skipUpdatedAt: true });

    context.config.compaction = { minimumAgeDays: 7 };

    const prompt = await loadCompactPlanPrompt({ plan: planPath }, context);
    const messageText = prompt.messages[0]?.content?.text ?? '';
    expect(messageText).toContain('Minimum age threshold: 7 days');
    expect(messageText).not.toContain('Warning: This plan was last updated');
  });

  test('mcpAppendResearch appends research to the plan file', async () => {
    const args = appendResearchParameters.parse({
      plan: planPath,
      research: '### Notes\n- Found relevant module',
      timestamp: false,
    });
    const result = await mcpAppendResearch(args, context);
    expect(result).toContain('Appended research');

    const updated = await readPlanFile(planPath);
    expect(updated.details).toContain('## Research');
    expect(updated.details).toContain('### Notes');
  });

  test('mcpUpdatePlanTasks updates plan with structured data', async () => {
    const args = generateTasksParameters.parse({
      plan: planPath,
      goal: 'Ship a high-quality feature',
      details: 'Updated details about the plan.',
      priority: 'high',
      tasks: [
        {
          title: 'Implement core functionality',
          description: 'Build the main feature',
        },
        {
          title: 'Add tests',
          description: 'Ensure coverage',
        },
      ],
    });
    const stubLogger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };
    const result = await mcpUpdatePlanTasks(args, context, { log: stubLogger });
    expect(result).toContain('Successfully updated plan');
    expect(result).toContain('2 tasks');

    // Verify the plan was actually updated
    const updated = await readPlanFile(planPath);
    expect(updated.tasks).toHaveLength(2);
    expect(updated.tasks[0]?.title).toBe('Implement core functionality');
    expect(updated.tasks[0]?.description).toBe('Build the main feature');
    expect(updated.tasks[1]?.title).toBe('Add tests');
    expect(updated.tasks[1]?.description).toBe('Ensure coverage');
    expect(updated.details).toContain('Updated details about the plan.');
    expect(updated.priority).toBe('high');
  });

  test('mcpGetPlan retrieves plan details', async () => {
    const args = getPlanParameters.parse({ plan: planPath });
    const result = await mcpGetPlan(args, context);
    expect(result).toContain('Plan ID: 99999');
    expect(result).toContain('Test Plan');
    expect(result).toContain('Ship a high-quality feature');
    expect(result).toContain('Initial details about the plan.');
    expect(result).toContain('Status: pending');
    expect(result).toContain('Priority: medium');
  });

  test('mcpUpdatePlanTasks adds delimiters on first update', async () => {
    const args = generateTasksParameters.parse({
      plan: planPath,
      details: 'First generated details.',
      tasks: [
        {
          title: 'Task 1',
          description: 'Description',
        },
      ],
    });

    const stubLogger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };

    await mcpUpdatePlanTasks(args, context, { log: stubLogger });

    const updated = await readPlanFile(planPath);
    expect(updated.details).toContain('<!-- rmplan-generated-start -->');
    expect(updated.details).toContain('<!-- rmplan-generated-end -->');
    expect(updated.details).toContain('First generated details.');
  });

  test('mcpUpdatePlanTasks replaces content between delimiters on subsequent update', async () => {
    // First update adds delimiters
    const firstArgs = generateTasksParameters.parse({
      plan: planPath,
      details: 'First generated details.',
      tasks: [{ title: 'Task 1', description: 'Description' }],
    });

    const stubLogger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };

    await mcpUpdatePlanTasks(firstArgs, context, { log: stubLogger });

    // Second update replaces content between delimiters
    const secondArgs = generateTasksParameters.parse({
      plan: planPath,
      details: 'Second generated details (updated).',
      tasks: [{ title: 'Task 2', description: 'New description' }],
    });

    await mcpUpdatePlanTasks(secondArgs, context, { log: stubLogger });

    const updated = await readPlanFile(planPath);
    expect(updated.details).toContain('<!-- rmplan-generated-start -->');
    expect(updated.details).toContain('<!-- rmplan-generated-end -->');
    expect(updated.details).toContain('Second generated details (updated).');
    expect(updated.details).not.toContain('First generated details.');
  });

  test('mcpUpdatePlanTasks inserts delimiters before Research section', async () => {
    // Set up plan with research section but no delimiters
    const planWithResearch: PlanSchema = {
      ...basePlan,
      details: `Initial details about the plan.

## Research

### Key Findings
- Found relevant authentication module`,
    };
    await writePlanFile(planPath, planWithResearch);

    // Update with new generated details
    const args = generateTasksParameters.parse({
      plan: planPath,
      details: 'New generated details.',
      tasks: [{ title: 'Task 1', description: 'Description' }],
    });

    const stubLogger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };

    await mcpUpdatePlanTasks(args, context, { log: stubLogger });

    // Verify delimiters were inserted before Research section
    const updated = await readPlanFile(planPath);
    expect(updated.details).toContain('<!-- rmplan-generated-start -->');
    expect(updated.details).toContain('<!-- rmplan-generated-end -->');
    expect(updated.details).toContain('New generated details.');
    expect(updated.details).toContain('## Research');
    expect(updated.details).toContain('Found relevant authentication module');

    // Verify order: generated content comes before research
    const generatedEndIndex = updated.details!.indexOf('<!-- rmplan-generated-end -->');
    const researchIndex = updated.details!.indexOf('## Research');
    expect(generatedEndIndex).toBeLessThan(researchIndex);
  });

  test('mcpUpdatePlanTasks preserves research section across multiple updates', async () => {
    // Set up plan with research section
    const planWithResearch: PlanSchema = {
      ...basePlan,
      details: `Initial details.

## Research

### Key Findings
- Important research data that should be preserved`,
    };
    await writePlanFile(planPath, planWithResearch);

    const stubLogger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };

    // First update
    await mcpUpdatePlanTasks(
      generateTasksParameters.parse({
        plan: planPath,
        details: 'First update.',
        tasks: [{ title: 'Task 1', description: 'Desc' }],
      }),
      context,
      { log: stubLogger }
    );

    let updated = await readPlanFile(planPath);
    expect(updated.details).toContain('First update.');
    expect(updated.details).toContain('## Research');
    expect(updated.details).toContain('Important research data that should be preserved');

    // Second update - research should still be preserved
    await mcpUpdatePlanTasks(
      generateTasksParameters.parse({
        plan: planPath,
        details: 'Second update.',
        tasks: [{ title: 'Task 2', description: 'Desc' }],
      }),
      context,
      { log: stubLogger }
    );

    updated = await readPlanFile(planPath);
    expect(updated.details).toContain('Second update.');
    expect(updated.details).not.toContain('First update.');
    expect(updated.details).toContain('## Research');
    expect(updated.details).toContain('Important research data that should be preserved');
  });

  // Tests for unified mcpManagePlanTask function
  test('mcpManagePlanTask with action=add creates task with metadata', async () => {
    const args = managePlanTaskParameters.parse({
      plan: planPath,
      action: 'add',
      title: 'Investigate issue',
      description: 'Reproduce the bug and identify the failing component.',
      files: ['src/issues.ts'],
      docs: ['docs/triage.md'],
    });

    const stubLogger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };

    const result = await mcpManagePlanTask(args, context, { log: stubLogger });
    expect(result).toContain('Added task "Investigate issue"');

    const updated = await readPlanFile(planPath);
    expect(updated.tasks).toHaveLength(1);
    const task = updated.tasks[0];
    expect(task?.title).toBe('Investigate issue');
    expect(task?.description).toContain('Reproduce the bug');
    expect(task?.files).toEqual(['src/issues.ts']);
    expect(task?.docs).toEqual(['docs/triage.md']);
    expect(task?.done).toBeFalse();
    expect(Array.isArray(task?.steps)).toBeTrue();
  });

  test('mcpManagePlanTask with action=remove deletes by title and reports shifts', async () => {
    const stubLogger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };

    await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'add',
        title: 'First Task',
        description: 'Initial task',
      }),
      context,
      { log: stubLogger }
    );
    await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'add',
        title: 'Follow-up Task',
        description: 'Secondary task',
      }),
      context,
      { log: stubLogger }
    );

    const result = await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'remove',
        taskTitle: 'first',
      }),
      context,
      { log: stubLogger }
    );

    expect(result).toContain('Removed task "First Task"');
    expect(result).toContain('have shifted');

    const updated = await readPlanFile(planPath);
    expect(updated.tasks).toHaveLength(1);
    expect(updated.tasks[0]?.title).toBe('Follow-up Task');
  });

  test('mcpManagePlanTask with action=remove errors on missing selectors', async () => {
    await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'add',
        title: 'Existing Task',
        description: 'Something to remove',
      }),
      context
    );

    await expect(
      mcpManagePlanTask(
        managePlanTaskParameters.parse({
          plan: planPath,
          action: 'remove',
        }),
        context
      )
    ).rejects.toThrow('Provide either taskTitle or taskIndex to remove a task.');
  });

  test('mcpManagePlanTask with action=update modifies task title by title selector', async () => {
    const stubLogger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };

    await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'add',
        title: 'Original Task',
        description: 'Original description',
      }),
      context,
      { log: stubLogger }
    );

    const result = await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'update',
        taskTitle: 'original',
        title: 'Updated Task Title',
      }),
      context,
      { log: stubLogger }
    );

    expect(result).toContain('Updated task "Original Task"');
    expect(result).toContain('title to "Updated Task Title"');

    const updated = await readPlanFile(planPath);
    expect(updated.tasks).toHaveLength(1);
    expect(updated.tasks[0]?.title).toBe('Updated Task Title');
    expect(updated.tasks[0]?.description).toBe('Original description');
  });

  test('mcpManagePlanTask with action=update modifies description by index', async () => {
    const stubLogger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };

    await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'add',
        title: 'Task Title',
        description: 'Original description',
      }),
      context,
      { log: stubLogger }
    );

    const result = await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'update',
        taskIndex: 0,
        description: 'Updated description with more details',
      }),
      context,
      { log: stubLogger }
    );

    expect(result).toContain('Updated task "Task Title"');
    expect(result).toContain('description');

    const updated = await readPlanFile(planPath);
    expect(updated.tasks).toHaveLength(1);
    expect(updated.tasks[0]?.title).toBe('Task Title');
    expect(updated.tasks[0]?.description).toBe('Updated description with more details');
  });

  test('mcpManagePlanTask with action=update modifies done status', async () => {
    const stubLogger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };

    await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'add',
        title: 'Task to Complete',
        description: 'Task description',
      }),
      context,
      { log: stubLogger }
    );

    const result = await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'update',
        taskTitle: 'complete',
        done: true,
      }),
      context,
      { log: stubLogger }
    );

    expect(result).toContain('Updated task "Task to Complete"');
    expect(result).toContain('done status to true');

    const updated = await readPlanFile(planPath);
    expect(updated.tasks).toHaveLength(1);
    expect(updated.tasks[0]?.done).toBeTrue();
  });

  test('mcpManagePlanTask with action=update modifies multiple fields at once', async () => {
    const stubLogger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };

    await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'add',
        title: 'Multi-update Task',
        description: 'Original description',
      }),
      context,
      { log: stubLogger }
    );

    const result = await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'update',
        taskIndex: 0,
        title: 'Updated Title',
        description: 'Updated description',
        done: true,
      }),
      context,
      { log: stubLogger }
    );

    expect(result).toContain('Updated task "Multi-update Task"');
    expect(result).toContain('title to "Updated Title"');
    expect(result).toContain('description');
    expect(result).toContain('done status to true');

    const updated = await readPlanFile(planPath);
    expect(updated.tasks).toHaveLength(1);
    expect(updated.tasks[0]?.title).toBe('Updated Title');
    expect(updated.tasks[0]?.description).toBe('Updated description');
    expect(updated.tasks[0]?.done).toBeTrue();
  });

  test('mcpManagePlanTask with action=update errors when no update fields provided', async () => {
    await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'add',
        title: 'Task',
        description: 'Description',
      }),
      context
    );

    await expect(
      mcpManagePlanTask(
        managePlanTaskParameters.parse({
          plan: planPath,
          action: 'update',
          taskIndex: 0,
        }),
        context
      )
    ).rejects.toThrow(
      'At least one of newTitle, newDescription, or done must be provided to update a task.'
    );
  });

  test('mcpManagePlanTask with action=update errors when task title not found', async () => {
    await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'add',
        title: 'Existing Task',
        description: 'Description',
      }),
      context
    );

    await expect(
      mcpManagePlanTask(
        managePlanTaskParameters.parse({
          plan: planPath,
          action: 'update',
          taskTitle: 'nonexistent',
          title: 'Updated',
        }),
        context
      )
    ).rejects.toThrow('No task found with title containing "nonexistent"');
  });

  test('mcpManagePlanTask with action=update errors when index out of bounds', async () => {
    await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'add',
        title: 'Task',
        description: 'Description',
      }),
      context
    );

    await expect(
      mcpManagePlanTask(
        managePlanTaskParameters.parse({
          plan: planPath,
          action: 'update',
          taskIndex: 5,
          title: 'Updated',
        }),
        context
      )
    ).rejects.toThrow('Task index 5 is out of bounds');
  });

  test('mcpManagePlanTask with action=update errors on empty title', async () => {
    await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'add',
        title: 'Task',
        description: 'Description',
      }),
      context
    );

    await expect(
      mcpManagePlanTask(
        managePlanTaskParameters.parse({
          plan: planPath,
          action: 'update',
          taskIndex: 0,
          title: '   ',
        }),
        context
      )
    ).rejects.toThrow('New task title cannot be empty');
  });

  test('mcpManagePlanTask with action=update errors on empty description', async () => {
    await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'add',
        title: 'Task',
        description: 'Description',
      }),
      context
    );

    await expect(
      mcpManagePlanTask(
        managePlanTaskParameters.parse({
          plan: planPath,
          action: 'update',
          taskIndex: 0,
          description: '   ',
        }),
        context
      )
    ).rejects.toThrow('New task description cannot be empty');
  });

  test('mcpManagePlanTask with action=update errors on missing selectors', async () => {
    await mcpManagePlanTask(
      managePlanTaskParameters.parse({
        plan: planPath,
        action: 'add',
        title: 'Task',
        description: 'Description',
      }),
      context
    );

    await expect(
      mcpManagePlanTask(
        managePlanTaskParameters.parse({
          plan: planPath,
          action: 'update',
          title: 'Updated',
        }),
        context
      )
    ).rejects.toThrow('Provide either taskTitle or taskIndex to update a task');
  });

  test('mcpManagePlanTask with action=add errors when title or description missing', async () => {
    const args = managePlanTaskParameters.parse({
      plan: planPath,
      action: 'add',
      title: 'Only Title',
      // description is missing
    });

    await expect(mcpManagePlanTask(args, context)).rejects.toThrow(
      'title and description are required for add action'
    );
  });
});

describe('mcpListReadyPlans', () => {
  let tmpDir: string;
  let context: GenerateModeRegistrationContext;

  beforeEach(async () => {
    clearPlanCache();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rmplan-mcp-ready-'));

    const config = getDefaultConfig();
    config.paths = { tasks: tmpDir };

    context = {
      config,
      configPath: undefined,
      gitRoot: tmpDir,
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    clearPlanCache();
  });

  // Helper function to create a plan
  async function createPlan(plan: PlanSchema) {
    const planPath = path.join(tmpDir, `${plan.id}-test.plan.md`);
    await writePlanFile(planPath, plan);
  }

  // Test 1: Returns all ready plans as JSON
  test('returns all ready plans as JSON', async () => {
    await createPlan({
      id: 1,
      title: 'Ready Plan 1',
      goal: 'Ship feature 1',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: '2025-01-15T10:00:00Z',
      updatedAt: '2025-01-20T10:00:00Z',
    });

    await createPlan({
      id: 2,
      title: 'Ready Plan 2',
      goal: 'Ship feature 2',
      status: 'in_progress',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: true }],
      dependencies: [],
      createdAt: '2025-01-16T10:00:00Z',
      updatedAt: '2025-01-21T10:00:00Z',
    });

    const args = listReadyPlansParameters.parse({
      pendingOnly: false,
    });

    const result = await mcpListReadyPlans(args, context);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(2);
    expect(parsed.plans).toHaveLength(2);

    // High priority should come before medium (descending order: higher priority first)
    expect(parsed.plans[0].id).toBe(1);
    expect(parsed.plans[0].title).toBe('Ready Plan 1');
    expect(parsed.plans[0].priority).toBe('high');
    expect(parsed.plans[0].status).toBe('pending');

    expect(parsed.plans[1].id).toBe(2);
    expect(parsed.plans[1].title).toBe('Ready Plan 2');
    expect(parsed.plans[1].priority).toBe('medium');
    expect(parsed.plans[1].status).toBe('in_progress');
  });

  // Test 2: Respects priority filter
  test('respects priority filter', async () => {
    await createPlan({
      id: 1,
      title: 'High Priority Plan',
      goal: 'Ship feature',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      title: 'Low Priority Plan',
      goal: 'Ship feature',
      status: 'pending',
      priority: 'low',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 3,
      title: 'Medium Priority Plan',
      goal: 'Ship feature',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const args = listReadyPlansParameters.parse({
      priority: 'high',
    });

    const result = await mcpListReadyPlans(args, context);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(1);
    expect(parsed.plans).toHaveLength(1);
    expect(parsed.plans[0].id).toBe(1);
    expect(parsed.plans[0].priority).toBe('high');
  });

  // Test 3: Respects limit parameter
  test('respects limit parameter', async () => {
    // Create 5 ready plans
    for (let i = 1; i <= 5; i++) {
      await createPlan({
        id: i,
        title: `Plan ${i}`,
        goal: 'Ship feature',
        status: 'pending',
        priority: 'medium',
        tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
        dependencies: [],
        createdAt: new Date().toISOString(),
      });
    }

    const args = listReadyPlansParameters.parse({
      limit: 3,
    });

    const result = await mcpListReadyPlans(args, context);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(3);
    expect(parsed.plans).toHaveLength(3);
  });

  test('applies limit after tag filtering', async () => {
    await createPlan({
      id: 1,
      title: 'UI polish',
      status: 'pending',
      priority: 'urgent',
      tags: ['frontend'],
      tasks: [],
      dependencies: [],
    });

    await createPlan({
      id: 2,
      title: 'Docs refresh',
      status: 'pending',
      priority: 'high',
      tags: ['docs'],
      tasks: [],
      dependencies: [],
    });

    await createPlan({
      id: 3,
      title: 'API hardening',
      status: 'pending',
      priority: 'medium',
      tags: ['backend'],
      tasks: [],
      dependencies: [],
    });

    const args = listReadyPlansParameters.parse({
      limit: 1,
      tags: ['backend'],
    });

    const result = await mcpListReadyPlans(args, context);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(1);
    expect(parsed.plans).toHaveLength(1);
    expect(parsed.plans[0].id).toBe(3);
    expect(parsed.plans[0].tags).toEqual(['backend']);
  });

  // Test 4: Respects pendingOnly flag
  test('respects pendingOnly flag', async () => {
    await createPlan({
      id: 1,
      title: 'Pending Plan',
      goal: 'Ship feature',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      title: 'In Progress Plan',
      goal: 'Ship feature',
      status: 'in_progress',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const args = listReadyPlansParameters.parse({
      pendingOnly: true,
    });

    const result = await mcpListReadyPlans(args, context);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(1);
    expect(parsed.plans).toHaveLength(1);
    expect(parsed.plans[0].id).toBe(1);
    expect(parsed.plans[0].status).toBe('pending');
  });

  // Test 5: Returns empty result when no ready plans
  test('returns empty result when no ready plans', async () => {
    // Create only done/cancelled plans
    await createPlan({
      id: 1,
      title: 'Done Plan',
      goal: 'Ship feature',
      status: 'done',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: true }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      title: 'Cancelled Plan',
      goal: 'Ship feature',
      status: 'cancelled',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const args = listReadyPlansParameters.parse({});

    const result = await mcpListReadyPlans(args, context);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(0);
    expect(parsed.plans).toHaveLength(0);
  });

  // Test 6: Sorts by priority correctly
  test('sorts by priority correctly', async () => {
    await createPlan({
      id: 1,
      title: 'Low Priority',
      goal: 'Ship feature',
      status: 'pending',
      priority: 'low',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      title: 'Urgent Priority',
      goal: 'Ship feature',
      status: 'pending',
      priority: 'urgent',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 3,
      title: 'High Priority',
      goal: 'Ship feature',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 4,
      title: 'Medium Priority',
      goal: 'Ship feature',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const args = listReadyPlansParameters.parse({
      sortBy: 'priority',
    });

    const result = await mcpListReadyPlans(args, context);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(4);

    // Verify order: urgent > high > medium > low (descending order: higher priority first)
    expect(parsed.plans[0].id).toBe(2); // urgent
    expect(parsed.plans[1].id).toBe(3); // high
    expect(parsed.plans[2].id).toBe(4); // medium
    expect(parsed.plans[3].id).toBe(1); // low
  });

  // Test 7: Includes all required fields
  test('includes all required fields', async () => {
    await createPlan({
      id: 1,
      title: 'Test Plan',
      goal: 'Ship a high-quality feature',
      status: 'pending',
      priority: 'high',
      tasks: [
        { title: 'Task 1', description: 'Do task', done: false },
        { title: 'Task 2', description: 'Do task', done: true },
      ],
      dependencies: [99],
      assignedTo: 'alice',
      createdAt: '2025-01-15T10:30:00Z',
      updatedAt: '2025-01-20T14:22:00Z',
    });

    // Create the dependency as done so plan 1 is ready
    await createPlan({
      id: 99,
      title: 'Dependency',
      goal: 'Foundation',
      status: 'done',
      priority: 'medium',
      tasks: [{ title: 'Task', description: 'Done', done: true }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const args = listReadyPlansParameters.parse({});

    const result = await mcpListReadyPlans(args, context);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(1);
    const plan = parsed.plans[0];

    // Verify all required fields are present
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Test Plan');
    expect(plan.goal).toBe('Ship a high-quality feature');
    expect(plan.priority).toBe('high');
    expect(plan.status).toBe('pending');
    expect(plan.taskCount).toBe(2);
    expect(plan.completedTasks).toBe(1);
    expect(plan.dependencies).toEqual([99]);
    expect(plan.assignedTo).toBe('alice');
    expect(plan.filename).toBeDefined();
    expect(plan.createdAt).toBe('2025-01-15T10:30:00Z');
    // updatedAt is automatically set by writePlanFile, so just check it exists
    expect(plan.updatedAt).toBeDefined();
  });

  // Test 8: Calculates task counts correctly
  test('calculates task counts correctly', async () => {
    await createPlan({
      id: 1,
      title: 'Test Plan',
      goal: 'Ship feature',
      status: 'pending',
      priority: 'medium',
      tasks: [
        { title: 'Task 1', description: 'Do task', done: false },
        { title: 'Task 2', description: 'Do task', done: true },
        { title: 'Task 3', description: 'Do task', done: false },
        { title: 'Task 4', description: 'Do task', done: true },
        { title: 'Task 5', description: 'Do task', done: true },
      ],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const args = listReadyPlansParameters.parse({});

    const result = await mcpListReadyPlans(args, context);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(1);
    const plan = parsed.plans[0];

    expect(plan.taskCount).toBe(5);
    expect(plan.completedTasks).toBe(3);
  });

  // Test 9: Handles missing optional fields
  test('handles missing optional fields', async () => {
    await createPlan({
      id: 1,
      goal: 'Test Plan', // No title
      status: 'pending',
      // No priority
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      // No assignedTo
      createdAt: new Date().toISOString(),
      // No updatedAt
    });

    const args = listReadyPlansParameters.parse({});

    const result = await mcpListReadyPlans(args, context);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(1);
    const plan = parsed.plans[0];

    // Verify optional fields are handled gracefully
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Test Plan'); // Falls back to goal
    expect(plan.goal).toBe('Test Plan');
    expect(plan.priority).toBeUndefined();
    expect(plan.assignedTo).toBeUndefined();
    // updatedAt is automatically set by writePlanFile even if not provided
    expect(plan.updatedAt).toBeDefined();
    expect(plan.createdAt).toBeDefined();
  });

  // Additional test: Excludes plans with incomplete dependencies
  test('excludes plans with incomplete dependencies', async () => {
    // Create a pending dependency
    await createPlan({
      id: 1,
      title: 'Dependency',
      goal: 'Foundation',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task', description: 'Not done', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    // Create a plan that depends on it
    await createPlan({
      id: 2,
      title: 'Blocked Plan',
      goal: 'Ship feature',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [1],
      createdAt: new Date().toISOString(),
    });

    const args = listReadyPlansParameters.parse({});

    const result = await mcpListReadyPlans(args, context);
    const parsed = JSON.parse(result);

    // Only the dependency (plan 1) should be ready, not plan 2
    expect(parsed.count).toBe(1);
    expect(parsed.plans[0].id).toBe(1);
  });

  // Additional test: Shows plans when dependencies are done
  test('shows plans when dependencies are done', async () => {
    // Create done dependencies
    await createPlan({
      id: 1,
      title: 'Dependency 1',
      goal: 'Foundation',
      status: 'done',
      priority: 'medium',
      tasks: [{ title: 'Task', description: 'Done', done: true }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      title: 'Dependency 2',
      goal: 'Foundation',
      status: 'done',
      priority: 'medium',
      tasks: [{ title: 'Task', description: 'Done', done: true }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    // Create a plan that depends on them
    await createPlan({
      id: 3,
      title: 'Ready Plan',
      goal: 'Ship feature',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [1, 2],
      createdAt: new Date().toISOString(),
    });

    const args = listReadyPlansParameters.parse({});

    const result = await mcpListReadyPlans(args, context);
    const parsed = JSON.parse(result);

    // Plan 3 should be ready because all dependencies are done
    expect(parsed.count).toBe(1);
    expect(parsed.plans[0].id).toBe(3);
    expect(parsed.plans[0].title).toBe('Ready Plan');
    expect(parsed.plans[0].dependencies).toEqual([1, 2]);
  });

  test('filters ready plans by tags using OR logic', async () => {
    await createPlan({
      id: 1,
      title: 'Frontend Work',
      status: 'pending',
      tags: ['frontend'],
      tasks: [],
      dependencies: [],
    });

    await createPlan({
      id: 2,
      title: 'Backend Work',
      status: 'pending',
      tags: ['backend'],
      tasks: [],
      dependencies: [],
    });

    await createPlan({
      id: 3,
      title: 'Ops Work',
      status: 'pending',
      tags: ['ops'],
      tasks: [],
      dependencies: [],
    });

    const args = listReadyPlansParameters.parse({
      tags: ['Frontend', 'ops'],
    });

    const result = await mcpListReadyPlans(args, context);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(2);
    const ids = parsed.plans.map((plan: { id: number }) => plan.id).sort();
    expect(ids).toEqual([1, 3]);
  });

  test('reloads plan data without manual cache clearing', async () => {
    await createPlan({
      id: 1,
      title: 'Tagged Plan',
      status: 'pending',
      tags: ['frontend'],
      tasks: [],
      dependencies: [],
    });

    const initialArgs = listReadyPlansParameters.parse({ tags: ['frontend'] });
    const initialResult = await mcpListReadyPlans(initialArgs, context);
    const initialParsed = JSON.parse(initialResult);
    expect(initialParsed.count).toBe(1);
    expect(initialParsed.plans[0].tags).toEqual(['frontend']);

    const planPath = path.join(tmpDir, '1-test.plan.md');
    const planData = await readPlanFile(planPath);
    await writePlanFile(planPath, { ...planData, tags: ['ops'] });

    const updatedArgs = listReadyPlansParameters.parse({ tags: ['ops'] });
    const updatedResult = await mcpListReadyPlans(updatedArgs, context);
    const updatedParsed = JSON.parse(updatedResult);
    expect(updatedParsed.count).toBe(1);
    expect(updatedParsed.plans[0].tags).toEqual(['ops']);
  });

  test('includes normalized tags in JSON output', async () => {
    await createPlan({
      id: 1,
      title: 'Tagged Plan',
      status: 'pending',
      tags: ['Frontend', 'backend'],
      tasks: [],
      dependencies: [],
    });

    const args = listReadyPlansParameters.parse({});
    const result = await mcpListReadyPlans(args, context);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(1);
    expect(parsed.plans[0].tags).toEqual(['backend', 'frontend']);
  });
});

describe('Helper Functions', () => {
  let tmpDir: string;
  let context: GenerateModeRegistrationContext;

  beforeEach(async () => {
    clearPlanCache();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rmplan-helpers-'));

    const config = getDefaultConfig();
    config.paths = { tasks: tmpDir };

    context = {
      config,
      configPath: undefined,
      gitRoot: tmpDir,
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    clearPlanCache();
  });

  async function createPlan(plan: PlanSchema) {
    const planPath = path.join(tmpDir, `${plan.id}-test.plan.md`);
    await writePlanFile(planPath, plan);
  }

  describe('getNextPlanId', () => {
    test('returns 1 for empty directory', async () => {
      const { generateNumericPlanId } = await import('../id_utils.js');
      const nextId = await generateNumericPlanId(tmpDir);
      expect(nextId).toBe(1);
    });

    test('returns max+1 with existing plans', async () => {
      await createPlan({ id: 1, title: 'Plan 1', status: 'pending', tasks: [] });
      await createPlan({ id: 5, title: 'Plan 5', status: 'pending', tasks: [] });
      await createPlan({ id: 3, title: 'Plan 3', status: 'pending', tasks: [] });

      const { generateNumericPlanId } = await import('../id_utils.js');
      const nextId = await generateNumericPlanId(tmpDir);
      expect(nextId).toBe(6);
    });

    test('handles single plan correctly', async () => {
      await createPlan({ id: 42, title: 'Solo Plan', status: 'pending', tasks: [] });

      const { generateNumericPlanId } = await import('../id_utils.js');
      const nextId = await generateNumericPlanId(tmpDir);
      expect(nextId).toBe(43);
    });
  });

  describe('generatePlanFilename', () => {
    test('creates valid slugs from titles', async () => {
      const { generatePlanFilename } = await import('../utils/filename.js');

      expect(generatePlanFilename(1, 'Simple Title')).toBe('1-simple-title.plan.md');
      expect(generatePlanFilename(42, 'Add Feature X')).toBe('42-add-feature-x.plan.md');
      expect(generatePlanFilename(100, 'Fix Bug: Authentication Issues')).toBe(
        '100-fix-bug-authentication-issues.plan.md'
      );
    });

    test('handles special characters correctly', async () => {
      const { generatePlanFilename } = await import('../utils/filename.js');

      expect(generatePlanFilename(1, 'Test & Development')).toBe('1-test-development.plan.md');
      expect(generatePlanFilename(2, 'API/V2 Migration')).toBe('2-api-v2-migration.plan.md');
      expect(generatePlanFilename(3, 'Update @types/node')).toBe('3-update-types-node.plan.md');
    });

    test('truncates long titles to 50 characters', async () => {
      const { generatePlanFilename } = await import('../utils/filename.js');

      const longTitle =
        'This is a very long title that should be truncated to fifty characters max';
      const filename = generatePlanFilename(1, longTitle);
      const slug = filename.replace('1-', '').replace('.plan.md', '');
      expect(slug.length).toBeLessThanOrEqual(50);
      expect(filename).toBe('1-this-is-a-very-long-title-that-should-be-truncated.plan.md');
    });

    test('removes leading and trailing dashes', async () => {
      const { generatePlanFilename } = await import('../utils/filename.js');

      expect(generatePlanFilename(1, '---Test---')).toBe('1-test.plan.md');
      expect(generatePlanFilename(2, '!!!Important!!!')).toBe('2-important.plan.md');
    });

    test('handles empty-like titles', async () => {
      const { generatePlanFilename } = await import('../utils/filename.js');

      expect(generatePlanFilename(1, '!!!')).toBe('1-.plan.md');
      expect(generatePlanFilename(2, '   ')).toBe('2-.plan.md');
    });
  });
});

describe('mcpCreatePlan', () => {
  let tmpDir: string;
  let context: GenerateModeRegistrationContext;

  beforeEach(async () => {
    clearPlanCache();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rmplan-create-'));

    const config = getDefaultConfig();
    config.paths = { tasks: tmpDir };

    context = {
      config,
      configPath: undefined,
      gitRoot: tmpDir,
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    clearPlanCache();
  });

  async function createPlan(plan: PlanSchema) {
    const planPath = path.join(tmpDir, `${plan.id}-test.plan.md`);
    await writePlanFile(planPath, plan);
  }

  test('creates valid plan file with minimal args', async () => {
    const { mcpCreatePlan, createPlanParameters } = await import('./generate_mode.js');

    const args = createPlanParameters.parse({
      title: 'Test Plan',
    });

    const result = await mcpCreatePlan(args, context);

    expect(result).toContain('Created plan 1 at');
    expect(result).toContain('1-test-plan.plan.md');

    const planPath = path.join(tmpDir, '1-test-plan.plan.md');
    const plan = await readPlanFile(planPath);

    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Test Plan');
    expect(plan.status).toBe('pending');
    expect(plan.tasks).toEqual([]);
    expect(plan.dependencies).toEqual([]);
    expect(plan.container).toBe(false);
    expect(plan.temp).toBe(false);
    expect(plan.createdAt).toBeDefined();
    expect(plan.updatedAt).toBeDefined();
  });

  test('sets all optional properties correctly', async () => {
    const { mcpCreatePlan, createPlanParameters } = await import('./generate_mode.js');

    const args = createPlanParameters.parse({
      title: 'Feature Plan',
      goal: 'Implement new feature',
      details: '## Overview\nThis is a test plan.',
      priority: 'high',
      dependsOn: [10, 20],
      discoveredFrom: 5,
      assignedTo: 'alice',
      issue: ['https://github.com/org/repo/issues/123'],
      docs: ['docs/feature.md'],
      container: true,
      temp: false,
    });

    const result = await mcpCreatePlan(args, context);

    expect(result).toContain('Created plan 1 at');

    const planPath = path.join(tmpDir, '1-feature-plan.plan.md');
    const plan = await readPlanFile(planPath);

    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Feature Plan');
    expect(plan.goal).toBe('Implement new feature');
    expect(plan.details).toBe('## Overview\nThis is a test plan.');
    expect(plan.priority).toBe('high');
    expect(plan.dependencies).toEqual([10, 20]);
    expect(plan.discoveredFrom).toBe(5);
    expect(plan.assignedTo).toBe('alice');
    expect(plan.issue).toEqual(['https://github.com/org/repo/issues/123']);
    expect(plan.docs).toEqual(['docs/feature.md']);
    expect(plan.container).toBe(true);
    expect(plan.temp).toBe(false);
  });

  test('accepts tags parameter and normalizes input', async () => {
    const { mcpCreatePlan, createPlanParameters } = await import('./generate_mode.js');

    const args = createPlanParameters.parse({
      title: 'Tagged Plan',
      tags: ['Frontend', 'backend', ' FRONTEND '],
    });

    await mcpCreatePlan(args, context);

    const planPath = path.join(tmpDir, '1-tagged-plan.plan.md');
    const plan = await readPlanFile(planPath);
    expect(plan.tags).toEqual(['backend', 'frontend']);
  });

  test('rejects tags that are not in the allowlist', async () => {
    const { mcpCreatePlan, createPlanParameters } = await import('./generate_mode.js');

    context.config.tags = { allowed: ['frontend'] };

    const args = createPlanParameters.parse({
      title: 'Invalid Tags',
      tags: ['backend'],
    });

    await expect(mcpCreatePlan(args, context)).rejects.toThrow('Invalid tag');
  });

  test('updates parent plan when parent specified', async () => {
    await createPlan({
      id: 10,
      title: 'Parent Plan',
      status: 'pending',
      dependencies: [],
      tasks: [],
    });

    // Clear cache to ensure getNextPlanId gets correct value
    clearPlanCache();

    const { mcpCreatePlan, createPlanParameters } = await import('./generate_mode.js');

    const args = createPlanParameters.parse({
      title: 'Child Plan',
      parent: 10,
    });

    const result = await mcpCreatePlan(args, context);

    expect(result).toContain('Created plan 11 at');

    // Parent plan should be modified to maintain bidirectional relationship
    const parentPlan = await readPlanFile(path.join(tmpDir, '10-test.plan.md'));
    expect(parentPlan.dependencies).toContain(11);

    const childPlan = await readPlanFile(path.join(tmpDir, '11-child-plan.plan.md'));
    expect(childPlan.parent).toBe(10);
  });

  test('generates unique plan IDs for multiple plans', async () => {
    const { mcpCreatePlan, createPlanParameters } = await import('./generate_mode.js');

    const args1 = createPlanParameters.parse({ title: 'Plan 1' });
    const result1 = await mcpCreatePlan(args1, context);
    expect(result1).toContain('Created plan 1 at');

    clearPlanCache();

    const args2 = createPlanParameters.parse({ title: 'Plan 2' });
    const result2 = await mcpCreatePlan(args2, context);
    expect(result2).toContain('Created plan 2 at');

    clearPlanCache();

    const args3 = createPlanParameters.parse({ title: 'Plan 3' });
    const result3 = await mcpCreatePlan(args3, context);
    expect(result3).toContain('Created plan 3 at');

    const plan1 = await readPlanFile(path.join(tmpDir, '1-plan-1.plan.md'));
    const plan2 = await readPlanFile(path.join(tmpDir, '2-plan-2.plan.md'));
    const plan3 = await readPlanFile(path.join(tmpDir, '3-plan-3.plan.md'));

    expect(plan1.id).toBe(1);
    expect(plan2.id).toBe(2);
    expect(plan3.id).toBe(3);
  });

  test('returns correct path in response', async () => {
    const { mcpCreatePlan, createPlanParameters } = await import('./generate_mode.js');

    const args = createPlanParameters.parse({ title: 'My Test Plan' });
    const result = await mcpCreatePlan(args, context);

    expect(result).toContain('Created plan 1 at');
    expect(result).toContain('1-my-test-plan.plan.md');
    expect(result).not.toContain(tmpDir); // Should be relative path
  });

  test('handles special characters in title for filename', async () => {
    const { mcpCreatePlan, createPlanParameters } = await import('./generate_mode.js');

    const args = createPlanParameters.parse({ title: 'Fix: Auth & Sessions!' });
    const result = await mcpCreatePlan(args, context);

    expect(result).toContain('Created plan 1 at');
    expect(result).toContain('1-fix-auth-sessions.plan.md');

    const planPath = path.join(tmpDir, '1-fix-auth-sessions.plan.md');
    const plan = await readPlanFile(planPath);
    expect(plan.title).toBe('Fix: Auth & Sessions!');
  });

  test('calls execution logger when provided', async () => {
    const { mcpCreatePlan, createPlanParameters } = await import('./generate_mode.js');

    let loggedInfo = false;
    const stubLogger = {
      debug() {},
      error() {},
      info() {
        loggedInfo = true;
      },
      warn() {},
    };

    const args = createPlanParameters.parse({ title: 'Logged Plan' });
    await mcpCreatePlan(args, context, { log: stubLogger });

    expect(loggedInfo).toBe(true);
  });

  test('sets default values for arrays and booleans', async () => {
    const { mcpCreatePlan, createPlanParameters } = await import('./generate_mode.js');

    const args = createPlanParameters.parse({ title: 'Minimal Plan' });
    await mcpCreatePlan(args, context);

    const planPath = path.join(tmpDir, '1-minimal-plan.plan.md');
    const plan = await readPlanFile(planPath);

    expect(plan.issue).toEqual([]);
    expect(plan.docs).toEqual([]);
    expect(plan.dependencies).toEqual([]);
    expect(plan.container).toBe(false);
    expect(plan.temp).toBe(false);
  });

  test('increments from existing highest ID', async () => {
    await createPlan({
      id: 5,
      title: 'Existing Plan',
      status: 'pending',
      tasks: [],
    });

    const { mcpCreatePlan, createPlanParameters } = await import('./generate_mode.js');

    const args = createPlanParameters.parse({ title: 'New Plan' });
    const result = await mcpCreatePlan(args, context);

    expect(result).toContain('Created plan 6 at');

    const planPath = path.join(tmpDir, '6-new-plan.plan.md');
    const plan = await readPlanFile(planPath);
    expect(plan.id).toBe(6);
  });

  test('rejects empty title', async () => {
    const { mcpCreatePlan, createPlanParameters } = await import('./generate_mode.js');

    const args = createPlanParameters.parse({ title: '' });
    await expect(mcpCreatePlan(args, context)).rejects.toThrow('Plan title cannot be empty');
  });

  test('rejects whitespace-only title', async () => {
    const { mcpCreatePlan, createPlanParameters } = await import('./generate_mode.js');

    const args = createPlanParameters.parse({ title: '   ' });
    await expect(mcpCreatePlan(args, context)).rejects.toThrow('Plan title cannot be empty');
  });

  test('trims whitespace from title', async () => {
    const { mcpCreatePlan, createPlanParameters } = await import('./generate_mode.js');

    const args = createPlanParameters.parse({ title: '  Trimmed Plan  ' });
    const result = await mcpCreatePlan(args, context);

    expect(result).toContain('Created plan 1 at');

    const planPath = path.join(tmpDir, '1-trimmed-plan.plan.md');
    const plan = await readPlanFile(planPath);
    expect(plan.title).toBe('Trimmed Plan');
  });
});

describe('MCP Resources', () => {
  let tmpDir: string;
  let context: GenerateModeRegistrationContext;

  beforeEach(async () => {
    clearPlanCache();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rmplan-resources-'));

    const config = getDefaultConfig();
    config.paths = { tasks: tmpDir };

    context = {
      config,
      configPath: undefined,
      gitRoot: tmpDir,
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    clearPlanCache();
  });

  async function createPlan(plan: PlanSchema) {
    const planPath = path.join(tmpDir, `${plan.id}-test.plan.md`);
    await writePlanFile(planPath, plan);
  }

  describe('rmplan://plans/list', () => {
    test('returns all plans with summaries', async () => {
      await createPlan({
        id: 1,
        title: 'Plan 1',
        goal: 'Goal 1',
        status: 'pending',
        priority: 'high',
        tasks: [
          { title: 'Task 1', description: 'Do task', done: false },
          { title: 'Task 2', description: 'Do task', done: true },
        ],
        dependencies: [5],
        assignedTo: 'alice',
        createdAt: '2025-01-15T10:00:00Z',
        updatedAt: '2025-01-20T10:00:00Z',
      });

      await createPlan({
        id: 2,
        title: 'Plan 2',
        goal: 'Goal 2',
        status: 'done',
        priority: 'low',
        tasks: [],
        dependencies: [],
        createdAt: '2025-01-16T10:00:00Z',
        updatedAt: '2025-01-21T10:00:00Z',
      });

      const { readAllPlans } = await import('../plans.js');
      const { plans } = await readAllPlans(tmpDir);

      const planList = Array.from(plans.values()).map((plan) => ({
        id: plan.id,
        title: plan.title,
        goal: plan.goal,
        status: plan.status,
        priority: plan.priority,
        parent: plan.parent,
        dependencies: plan.dependencies,
        assignedTo: plan.assignedTo,
        taskCount: plan.tasks?.length || 0,
        completedTasks: plan.tasks?.filter((t) => t.done).length || 0,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      }));

      expect(planList).toHaveLength(2);

      const plan1 = planList.find((p) => p.id === 1);
      expect(plan1).toBeDefined();
      expect(plan1?.title).toBe('Plan 1');
      expect(plan1?.goal).toBe('Goal 1');
      expect(plan1?.status).toBe('pending');
      expect(plan1?.priority).toBe('high');
      expect(plan1?.taskCount).toBe(2);
      expect(plan1?.completedTasks).toBe(1);
      expect(plan1?.dependencies).toEqual([5]);
      expect(plan1?.assignedTo).toBe('alice');

      const plan2 = planList.find((p) => p.id === 2);
      expect(plan2).toBeDefined();
      expect(plan2?.title).toBe('Plan 2');
      expect(plan2?.status).toBe('done');
      expect(plan2?.taskCount).toBe(0);
    });

    test('returns valid JSON', async () => {
      await createPlan({
        id: 1,
        title: 'Test Plan',
        status: 'pending',
        tasks: [],
        dependencies: [],
      });

      const { readAllPlans } = await import('../plans.js');
      const { plans } = await readAllPlans(tmpDir);

      const planList = Array.from(plans.values()).map((plan) => ({
        id: plan.id,
        title: plan.title,
        goal: plan.goal,
        status: plan.status,
        priority: plan.priority,
        parent: plan.parent,
        dependencies: plan.dependencies,
        assignedTo: plan.assignedTo,
        taskCount: plan.tasks?.length || 0,
        completedTasks: plan.tasks?.filter((t) => t.done).length || 0,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      }));

      const jsonOutput = JSON.stringify(planList, null, 2);
      expect(() => JSON.parse(jsonOutput)).not.toThrow();

      const parsed = JSON.parse(jsonOutput);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
    });

    test('returns empty array for no plans', async () => {
      const { readAllPlans } = await import('../plans.js');
      const { plans } = await readAllPlans(tmpDir);

      const planList = Array.from(plans.values());
      expect(planList).toHaveLength(0);

      const jsonOutput = JSON.stringify(planList, null, 2);
      const parsed = JSON.parse(jsonOutput);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(0);
    });

    test('includes all required fields', async () => {
      await createPlan({
        id: 1,
        title: 'Complete Plan',
        goal: 'Test Goal',
        status: 'in_progress',
        priority: 'urgent',
        parent: 10,
        tasks: [
          { title: 'Task 1', description: 'Do task', done: false },
          { title: 'Task 2', description: 'Do task', done: true },
        ],
        dependencies: [5, 7],
        assignedTo: 'bob',
        createdAt: '2025-01-15T10:00:00Z',
      });

      const { readAllPlans } = await import('../plans.js');
      const { plans } = await readAllPlans(tmpDir);

      const planList = Array.from(plans.values()).map((plan) => ({
        id: plan.id,
        title: plan.title,
        goal: plan.goal,
        status: plan.status,
        priority: plan.priority,
        parent: plan.parent,
        dependencies: plan.dependencies,
        assignedTo: plan.assignedTo,
        taskCount: plan.tasks?.length || 0,
        completedTasks: plan.tasks?.filter((t) => t.done).length || 0,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      }));

      const plan = planList[0];
      expect(plan).toBeDefined();
      expect(plan?.id).toBe(1);
      expect(plan?.title).toBe('Complete Plan');
      expect(plan?.goal).toBe('Test Goal');
      expect(plan?.status).toBe('in_progress');
      expect(plan?.priority).toBe('urgent');
      expect(plan?.parent).toBe(10);
      expect(plan?.dependencies).toEqual([5, 7]);
      expect(plan?.assignedTo).toBe('bob');
      expect(plan?.taskCount).toBe(2);
      expect(plan?.completedTasks).toBe(1);
      expect(plan?.createdAt).toBe('2025-01-15T10:00:00Z');
      expect(plan?.updatedAt).toBeDefined(); // updatedAt is automatically set by writePlanFile
    });
  });

  describe('rmplan://plans/{planId}', () => {
    test('returns specific plan by ID', async () => {
      await createPlan({
        id: 42,
        title: 'Specific Plan',
        goal: 'Specific Goal',
        details: 'Detailed information',
        status: 'pending',
        priority: 'medium',
        tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
        dependencies: [],
        createdAt: '2025-01-15T10:00:00Z',
        updatedAt: '2025-01-20T10:00:00Z',
      });

      const planPath = path.join(tmpDir, '42-test.plan.md');
      const { plan } = await resolvePlan(planPath, context);

      expect(plan.id).toBe(42);
      expect(plan.title).toBe('Specific Plan');
      expect(plan.goal).toBe('Specific Goal');
      expect(plan.details).toBe('Detailed information');
      expect(plan.status).toBe('pending');
      expect(plan.priority).toBe('medium');
      expect(plan.tasks).toHaveLength(1);
    });

    test('returns specific plan by file path', async () => {
      await createPlan({
        id: 10,
        title: 'Path Plan',
        status: 'pending',
        tasks: [],
      });

      const planPath = path.join(tmpDir, '10-test.plan.md');
      const { plan } = await resolvePlan(planPath, context);

      expect(plan.id).toBe(10);
      expect(plan.title).toBe('Path Plan');
    });

    test('returns valid JSON', async () => {
      await createPlan({
        id: 1,
        title: 'JSON Plan',
        status: 'pending',
        tasks: [],
      });

      const planPath = path.join(tmpDir, '1-test.plan.md');
      const { plan } = await resolvePlan(planPath, context);
      const jsonOutput = JSON.stringify(plan, null, 2);

      expect(() => JSON.parse(jsonOutput)).not.toThrow();

      const parsed = JSON.parse(jsonOutput);
      expect(parsed.id).toBe(1);
      expect(parsed.title).toBe('JSON Plan');
    });

    test('throws error for invalid plan ID', async () => {
      await expect(resolvePlan('999', context)).rejects.toThrow();
    });

    test('includes full plan details', async () => {
      await createPlan({
        id: 1,
        title: 'Detailed Plan',
        goal: 'Complete Goal',
        details: '## Overview\nThis is detailed.',
        status: 'in_progress',
        priority: 'high',
        parent: 5,
        tasks: [
          { title: 'Task 1', description: 'First task', done: true },
          { title: 'Task 2', description: 'Second task', done: false },
        ],
        dependencies: [10, 20],
        discoveredFrom: 3,
        assignedTo: 'charlie',
        issue: ['https://github.com/org/repo/issues/1'],
        docs: ['docs/plan.md'],
        container: false,
        temp: true,
        createdAt: '2025-01-15T10:00:00Z',
        updatedAt: '2025-01-20T10:00:00Z',
      });

      const planPath = path.join(tmpDir, '1-test.plan.md');
      const { plan } = await resolvePlan(planPath, context);

      expect(plan.id).toBe(1);
      expect(plan.title).toBe('Detailed Plan');
      expect(plan.goal).toBe('Complete Goal');
      expect(plan.details).toContain('## Overview');
      expect(plan.status).toBe('in_progress');
      expect(plan.priority).toBe('high');
      expect(plan.parent).toBe(5);
      expect(plan.tasks).toHaveLength(2);
      expect(plan.dependencies).toEqual([10, 20]);
      expect(plan.discoveredFrom).toBe(3);
      expect(plan.assignedTo).toBe('charlie');
      expect(plan.issue).toEqual(['https://github.com/org/repo/issues/1']);
      expect(plan.docs).toEqual(['docs/plan.md']);
      expect(plan.container).toBe(false);
      expect(plan.temp).toBe(true);
    });
  });

  describe('rmplan://plans/ready', () => {
    test('filters by dependencies and status', async () => {
      // Create done dependency
      await createPlan({
        id: 1,
        title: 'Done Dependency',
        status: 'done',
        tasks: [],
        dependencies: [],
      });

      // Create pending dependency (not done, has tasks)
      await createPlan({
        id: 2,
        title: 'Pending Dependency',
        status: 'pending',
        tasks: [{ title: 'Task', description: 'Do it', done: false }],
        dependencies: [],
      });

      // Create ready plan (depends on done plan)
      await createPlan({
        id: 3,
        title: 'Ready Plan',
        status: 'pending',
        tasks: [{ title: 'Task', description: 'Do it', done: false }],
        dependencies: [1],
      });

      // Create blocked plan (depends on pending plan)
      await createPlan({
        id: 4,
        title: 'Blocked Plan',
        status: 'pending',
        tasks: [{ title: 'Task', description: 'Do it', done: false }],
        dependencies: [2],
      });

      // Create done plan (should not be ready)
      await createPlan({
        id: 5,
        title: 'Done Plan',
        status: 'done',
        tasks: [],
        dependencies: [],
      });

      const { filterAndSortReadyPlans } = await import('../ready_plans.js');
      const { plans } = await readAllPlans(tmpDir);

      const readyPlans = filterAndSortReadyPlans(plans, {
        pendingOnly: false,
        sortBy: 'priority',
      });

      // Should include plans 2 and 3
      // Plan 2 has no dependencies and has tasks (ready)
      // Plan 3 depends on plan 1 which is done and has tasks (ready)
      // Plan 4 depends on plan 2 which is pending (blocked)
      const readyIds = readyPlans.map((p) => p.id);
      expect(readyIds).toContain(2);
      expect(readyIds).toContain(3);
      expect(readyIds).not.toContain(1); // done
      expect(readyIds).not.toContain(4); // blocked
      expect(readyIds).not.toContain(5); // done
    });

    test('returns valid JSON', async () => {
      await createPlan({
        id: 1,
        title: 'Ready Plan',
        status: 'pending',
        tasks: [{ title: 'Task', description: 'Do it', done: false }],
        dependencies: [],
      });

      const { filterAndSortReadyPlans, formatReadyPlansAsJson } = await import('../ready_plans.js');
      const { plans } = await readAllPlans(tmpDir);

      const readyPlans = filterAndSortReadyPlans(plans, {
        pendingOnly: false,
        sortBy: 'priority',
      });

      const enrichedPlans = readyPlans.map((plan) => {
        const planId = typeof plan.id === 'number' ? plan.id : 0;
        return {
          ...plan,
          filename: plans.get(planId)?.filename || '',
        };
      });

      const jsonOutput = formatReadyPlansAsJson(enrichedPlans, { gitRoot: context.gitRoot });

      expect(() => JSON.parse(jsonOutput)).not.toThrow();

      const parsed = JSON.parse(jsonOutput);
      expect(parsed.count).toBe(1);
      expect(parsed.plans).toHaveLength(1);
    });

    test('returns empty result when no ready plans', async () => {
      await createPlan({
        id: 1,
        title: 'Done Plan',
        status: 'done',
        tasks: [],
        dependencies: [],
      });

      await createPlan({
        id: 2,
        title: 'Cancelled Plan',
        status: 'cancelled',
        tasks: [],
        dependencies: [],
      });

      const { filterAndSortReadyPlans, formatReadyPlansAsJson } = await import('../ready_plans.js');
      const { plans } = await readAllPlans(tmpDir);

      const readyPlans = filterAndSortReadyPlans(plans, {
        pendingOnly: false,
        sortBy: 'priority',
      });

      const jsonOutput = formatReadyPlansAsJson(readyPlans, { gitRoot: context.gitRoot });

      const parsed = JSON.parse(jsonOutput);
      expect(parsed.count).toBe(0);
      expect(parsed.plans).toHaveLength(0);
    });

    test('sorts by priority correctly', async () => {
      await createPlan({
        id: 1,
        title: 'Low Priority',
        status: 'pending',
        priority: 'low',
        tasks: [{ title: 'Task', description: 'Do it', done: false }],
        dependencies: [],
      });

      await createPlan({
        id: 2,
        title: 'Urgent Priority',
        status: 'pending',
        priority: 'urgent',
        tasks: [{ title: 'Task', description: 'Do it', done: false }],
        dependencies: [],
      });

      await createPlan({
        id: 3,
        title: 'High Priority',
        status: 'pending',
        priority: 'high',
        tasks: [{ title: 'Task', description: 'Do it', done: false }],
        dependencies: [],
      });

      const { filterAndSortReadyPlans } = await import('../ready_plans.js');
      const { plans } = await readAllPlans(tmpDir);

      const readyPlans = filterAndSortReadyPlans(plans, {
        pendingOnly: false,
        sortBy: 'priority',
      });

      expect(readyPlans[0]?.id).toBe(2); // urgent
      expect(readyPlans[1]?.id).toBe(3); // high
      expect(readyPlans[2]?.id).toBe(1); // low
    });
  });
});
