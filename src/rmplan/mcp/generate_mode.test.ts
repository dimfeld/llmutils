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
  handleGetPlanTool,
  loadGeneratePrompt,
  loadPlanPrompt,
  loadQuestionsPrompt,
  loadResearchPrompt,
  type GenerateModeRegistrationContext,
} from './generate_mode.js';

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

  test('handleGetPlanTool retrieves plan details', async () => {
    const args = getPlanParameters.parse({ plan: planPath });
    const result = await handleGetPlanTool(args, context);
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
