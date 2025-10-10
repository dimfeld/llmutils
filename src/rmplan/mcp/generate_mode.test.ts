import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDefaultConfig } from '../configSchema.js';
import type { PlanSchema } from '../planSchema.js';
import { writePlanFile, readPlanFile } from '../plans.js';
import {
  appendResearchParameters,
  generateTasksParameters,
  handleAppendResearchTool,
  handleGenerateTasksTool,
  loadQuestionsPrompt,
  loadResearchPrompt,
  type GenerateModeRegistrationContext,
} from './generate_mode.js';

const basePlan: PlanSchema = {
  id: 42,
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
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rmplan-mcp-'));
    planPath = path.join(tmpDir, '0042-test.plan.md');
    await writePlanFile(planPath, basePlan);
    context = {
      config: getDefaultConfig(),
      configPath: undefined,
      gitRoot: tmpDir,
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('loadResearchPrompt returns plan context with research template', async () => {
    const prompt = await loadResearchPrompt({ plan: planPath }, context);
    const message = prompt.messages[0]?.content;
    expect(message?.text).toContain('Test Plan');
    expect(message?.text).toContain('Use the following template to capture research');
    expect(message?.text).toContain('### Summary');
  });

  test('loadQuestionsPrompt encourages iterative questioning', async () => {
    const prompt = await loadQuestionsPrompt({ plan: planPath }, context);
    const message = prompt.messages[0]?.content;
    expect(message?.text).toContain('Ask one concise, high-impact question');
    expect(message?.text).toContain('Initial details about the plan.');
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
});
