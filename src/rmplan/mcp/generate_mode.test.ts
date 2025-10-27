import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDefaultConfig } from '../configSchema.js';
import type { PlanSchema } from '../planSchema.js';
import { writePlanFile, readPlanFile, clearPlanCache } from '../plans.js';
import {
  appendResearchParameters,
  generateTasksParameters,
  getPlanParameters,
  handleAppendResearchTool,
  handleGenerateTasksTool,
  handleListReadyPlansTool,
  listReadyPlansParameters,
  loadGeneratePrompt,
  loadPlanPrompt,
  loadQuestionsPrompt,
  loadResearchPrompt,
  type GenerateModeRegistrationContext,
} from './generate_mode.js';
import { mcpGetPlan } from '../commands/show.js';

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
    config.tasksDir = tmpDir;

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

  test('handleAppendResearchTool appends research to the plan file', async () => {
    const args = appendResearchParameters.parse({
      plan: planPath,
      research: '### Notes\n- Found relevant module',
      timestamp: false,
    });
    const result = await handleAppendResearchTool(args, context);
    expect(result).toContain('Appended research');

    const updated = await readPlanFile(planPath);
    expect(updated.details).toContain('## Research');
    expect(updated.details).toContain('### Notes');
  });

  test('handleGenerateTasksTool updates plan with structured data', async () => {
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
    const result = await handleGenerateTasksTool(args, context, { log: stubLogger });
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

  test('handleGenerateTasksTool adds delimiters on first update', async () => {
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

    await handleGenerateTasksTool(args, context, { log: stubLogger });

    const updated = await readPlanFile(planPath);
    expect(updated.details).toContain('<!-- rmplan-generated-start -->');
    expect(updated.details).toContain('<!-- rmplan-generated-end -->');
    expect(updated.details).toContain('First generated details.');
  });

  test('handleGenerateTasksTool replaces content between delimiters on subsequent update', async () => {
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

    await handleGenerateTasksTool(firstArgs, context, { log: stubLogger });

    // Second update replaces content between delimiters
    const secondArgs = generateTasksParameters.parse({
      plan: planPath,
      details: 'Second generated details (updated).',
      tasks: [{ title: 'Task 2', description: 'New description' }],
    });

    await handleGenerateTasksTool(secondArgs, context, { log: stubLogger });

    const updated = await readPlanFile(planPath);
    expect(updated.details).toContain('<!-- rmplan-generated-start -->');
    expect(updated.details).toContain('<!-- rmplan-generated-end -->');
    expect(updated.details).toContain('Second generated details (updated).');
    expect(updated.details).not.toContain('First generated details.');
  });

  test('handleGenerateTasksTool inserts delimiters before Research section', async () => {
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

    await handleGenerateTasksTool(args, context, { log: stubLogger });

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

  test('handleGenerateTasksTool preserves research section across multiple updates', async () => {
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
    await handleGenerateTasksTool(
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
    await handleGenerateTasksTool(
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
});

describe('handleListReadyPlansTool', () => {
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

    const result = await handleListReadyPlansTool(args, context);
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

    const result = await handleListReadyPlansTool(args, context);
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

    const result = await handleListReadyPlansTool(args, context);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(3);
    expect(parsed.plans).toHaveLength(3);
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

    const result = await handleListReadyPlansTool(args, context);
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

    const result = await handleListReadyPlansTool(args, context);
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

    const result = await handleListReadyPlansTool(args, context);
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

    const result = await handleListReadyPlansTool(args, context);
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

    const result = await handleListReadyPlansTool(args, context);
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

    const result = await handleListReadyPlansTool(args, context);
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

    const result = await handleListReadyPlansTool(args, context);
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

    const result = await handleListReadyPlansTool(args, context);
    const parsed = JSON.parse(result);

    // Plan 3 should be ready because all dependencies are done
    expect(parsed.count).toBe(1);
    expect(parsed.plans[0].id).toBe(3);
    expect(parsed.plans[0].title).toBe('Ready Plan');
    expect(parsed.plans[0].dependencies).toEqual([1, 2]);
  });
});
