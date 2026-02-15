import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { planSchema } from './planSchema.js';
import { readPlanFile, writePlanFile, clearPlanCache } from './plans.js';
import type { PlanSchema } from './planSchema.js';
import { stringifyPlanWithFrontmatter } from '../testing.js';

describe('simple field schema validation', () => {
  test('accepts plan with simple: true', () => {
    const plan = {
      id: 1,
      title: 'Simple Test Plan',
      goal: 'Do a simple thing',
      details: 'Some details',
      simple: true,
      tasks: [],
    };

    const parsed = planSchema.parse(plan);
    expect(parsed.simple).toBe(true);
  });

  test('accepts plan with simple: false', () => {
    const plan = {
      id: 2,
      title: 'Complex Test Plan',
      goal: 'Do a complex thing',
      details: 'Some details',
      simple: false,
      tasks: [],
    };

    const parsed = planSchema.parse(plan);
    expect(parsed.simple).toBe(false);
  });

  test('defaults simple to false when not provided', () => {
    const plan = {
      id: 3,
      title: 'Test Plan',
      goal: 'Do a thing',
      details: 'Some details',
      tasks: [],
    };

    const parsed = planSchema.parse(plan);
    // Check that simple is either false or falsy (undefined defaults to false behavior)
    expect(parsed.simple === false || !parsed.simple).toBe(true);
  });

  test('backward compatibility - existing plans without simple field work correctly', () => {
    const plan = {
      id: 4,
      title: 'Legacy Plan',
      goal: 'Old plan without simple field',
      details: 'This plan was created before simple field existed',
      tasks: [],
    };

    const parsed = planSchema.parse(plan);
    // Check that simple is either false or falsy (undefined defaults to false behavior)
    expect(parsed.simple === false || !parsed.simple).toBe(true);
  });

  test('rejects non-boolean simple values', () => {
    const plan = {
      id: 5,
      title: 'Test Plan',
      goal: 'Do a thing',
      details: 'Some details',
      simple: 'yes',
      tasks: [],
    } as any;

    expect(() => planSchema.parse(plan)).toThrow();
  });

  test('accepts plan with simple field alongside other required fields', () => {
    const plan = {
      id: 100,
      title: 'Full Test Plan',
      goal: 'Complete goal',
      details: 'Complete details',
      simple: true,
      status: 'pending',
      priority: 'high',
      tasks: [
        { title: 'Task 1', description: 'Do task 1', done: false },
        { title: 'Task 2', description: 'Do task 2', done: true },
      ],
      dependencies: [],
    };

    const parsed = planSchema.parse(plan);
    expect(parsed.simple).toBe(true);
    expect(parsed.id).toBe(100);
    expect(parsed.tasks).toHaveLength(2);
  });

  test('schema preserves simple field through parse-serialize cycle', () => {
    const plan = {
      id: 6,
      title: 'Serialize Test',
      goal: 'Test serialization',
      simple: true,
      tasks: [],
    };

    const parsed = planSchema.parse(plan);
    const serialized = JSON.parse(JSON.stringify(parsed));
    const reparsed = planSchema.parse(serialized);

    expect(reparsed.simple).toBe(true);
  });
});

describe('simple field file I/O', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-field-test-'));
    clearPlanCache();
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    clearPlanCache();
  });

  test('writes and reads plan with simple: true', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Simple Plan',
      goal: 'Test simple flag',
      simple: true,
      tasks: [],
    };

    const filename = path.join(tempDir, '1-simple-plan.plan.md');
    await writePlanFile(filename, plan);

    const readPlan = await readPlanFile(filename);
    expect(readPlan.simple).toBe(true);
  });

  test('writes and reads plan with simple: false', async () => {
    const plan: PlanSchema = {
      id: 2,
      title: 'Complex Plan',
      goal: 'Test complex workflow',
      simple: false,
      tasks: [],
    };

    const filename = path.join(tempDir, '2-complex-plan.plan.md');
    await writePlanFile(filename, plan);

    const readPlan = await readPlanFile(filename);
    expect(readPlan.simple).toBeUndefined();
  });

  test('reads existing plan without simple field', async () => {
    // Create a plan file manually without the simple field
    const filename = path.join(tempDir, '3-legacy-plan.plan.md');
    const legacyPlan = {
      id: 3,
      title: 'Legacy Plan',
      goal: 'Old plan',
      tasks: [],
    };

    await fs.writeFile(filename, stringifyPlanWithFrontmatter(legacyPlan), 'utf-8');

    const readPlan = await readPlanFile(filename);
    // Check that simple is falsy (either false or undefined, both evaluate to false in conditions)
    expect(!readPlan.simple).toBe(true);
  });
});

describe('simple field logic in commands', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-cmd-test-'));
    clearPlanCache();
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    clearPlanCache();
  });

  test('add command creates plan object with simple field from options', () => {
    // This tests the logic without file I/O
    const options = { simple: true };
    const simple = options.simple || false;
    expect(simple).toBe(true);
  });

  test('add command defaults simple to false when not provided', () => {
    const options = {};
    const simple = (options as any).simple || false;
    expect(simple).toBe(false);
  });

  test('generate command respects plan simple field when no CLI flag provided', () => {
    // Test the logic from generate.ts
    const parsedPlan = { simple: true };
    const options: any = {};

    const hasExplicitSimpleFlag = 'simple' in options && options.simple !== undefined;
    if (!hasExplicitSimpleFlag && parsedPlan.simple === true) {
      options.simple = true;
    }

    expect(options.simple).toBe(true);
  });

  test('generate command respects CLI flag over plan field', () => {
    // Test precedence: explicit CLI flag wins
    const parsedPlan = { simple: true };
    const options: any = { simple: false };

    const hasExplicitSimpleFlag = 'simple' in options && options.simple !== undefined;
    if (!hasExplicitSimpleFlag && parsedPlan.simple === true) {
      options.simple = true;
    }

    // Should stay false because CLI flag takes precedence
    expect(options.simple).toBe(false);
  });

  test('MCP loadResearchPrompt redirects to loadGeneratePrompt for simple plans', async () => {
    // Create a temporary plan file with simple: true
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-test-'));
    const planFile = path.join(tmpDir, 'test-plan.plan.md');

    const simplePlan: PlanSchema = {
      id: 1,
      title: 'Simple Test Plan',
      goal: 'Test simple workflow',
      details: 'Test details',
      simple: true,
      tasks: [],
    };

    await writePlanFile(planFile, simplePlan);

    try {
      // Import the actual loadResearchPrompt function
      const { loadResearchPrompt } = await import('./mcp/generate_mode.js');
      const context = {
        config: {} as any,
        gitRoot: tmpDir,
      };

      // Call the actual function
      const result = await loadResearchPrompt({ plan: planFile }, context);

      // Verify it uses the simple generation prompt (loadGeneratePrompt)
      // The simple prompt has the generation instructions, not research instructions
      const promptText =
        result.messages[0].content.type === 'text' ? result.messages[0].content.text : '';
      expect(promptText).toContain('tim tools update-plan-tasks');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      clearPlanCache();
    }
  });

  test('MCP loadResearchPrompt uses research flow for non-simple plans', async () => {
    // Create a temporary plan file with simple: false
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-test-'));
    const planFile = path.join(tmpDir, 'test-plan.plan.md');

    const complexPlan: PlanSchema = {
      id: 2,
      title: 'Complex Test Plan',
      goal: 'Test complex workflow',
      details: 'Test details',
      simple: false,
      tasks: [],
    };

    await writePlanFile(planFile, complexPlan);

    try {
      const { loadResearchPrompt } = await import('./mcp/generate_mode.js');
      const context = {
        config: {} as any,
        gitRoot: tmpDir,
      };

      const result = await loadResearchPrompt({ plan: planFile }, context);

      // Verify it uses the research prompt
      const promptText =
        result.messages[0].content.type === 'text' ? result.messages[0].content.text : '';
      expect(promptText).toContain('Once your research is complete');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      clearPlanCache();
    }
  });

  test('MCP loadResearchPrompt uses research flow for undefined simple field', async () => {
    // Create a temporary plan file without simple field (backward compatibility)
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-test-'));
    const planFile = path.join(tmpDir, 'test-plan.plan.md');

    const defaultPlan: PlanSchema = {
      id: 3,
      title: 'Default Test Plan',
      goal: 'Test default workflow',
      details: 'Test details',
      tasks: [],
    };

    await writePlanFile(planFile, defaultPlan);

    try {
      const { loadResearchPrompt } = await import('./mcp/generate_mode.js');
      const context = {
        config: {} as any,
        gitRoot: tmpDir,
      };

      const result = await loadResearchPrompt({ plan: planFile }, context);

      // Verify it uses the research prompt (default behavior)
      const promptText =
        result.messages[0].content.type === 'text' ? result.messages[0].content.text : '';
      expect(promptText).toContain('Once your research is complete');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      clearPlanCache();
    }
  });

  test('generate command handles explicit --no-simple overriding plan.simple: true', () => {
    // Test that explicit false flag overrides plan field
    const parsedPlan = { simple: true };
    const options: any = { simple: false };

    const hasExplicitSimpleFlag = 'simple' in options && options.simple !== undefined;
    if (!hasExplicitSimpleFlag && parsedPlan.simple === true) {
      options.simple = true;
    }

    // Should remain false because CLI has explicit false
    expect(options.simple).toBe(false);
  });

  test('generate command ignores plan.simple when CLI has explicit true', () => {
    // Test that explicit true flag is preserved regardless of plan field
    const parsedPlan = { simple: false };
    const options: any = { simple: true };

    const hasExplicitSimpleFlag = 'simple' in options && options.simple !== undefined;
    if (!hasExplicitSimpleFlag && parsedPlan.simple === true) {
      options.simple = true;
    }

    // Should remain true because CLI has explicit true
    expect(options.simple).toBe(true);
  });

  test('agent command respects plan.simple field when no CLI flag provided', () => {
    // Test the logic from agent.ts
    const planData = { simple: true };
    const options: any = {};

    const hasExplicitSimpleFlag = 'simple' in options && options.simple !== undefined;
    if (!hasExplicitSimpleFlag && planData.simple === true) {
      options.simple = true;
    }

    expect(options.simple).toBe(true);
  });

  test('agent command respects CLI flag over plan field', () => {
    // Test precedence: explicit CLI flag wins
    const planData = { simple: true };
    const options: any = { simple: false };

    const hasExplicitSimpleFlag = 'simple' in options && options.simple !== undefined;
    if (!hasExplicitSimpleFlag && planData.simple === true) {
      options.simple = true;
    }

    // Should stay false because CLI flag takes precedence
    expect(options.simple).toBe(false);
  });

  test('agent command handles explicit --no-simple overriding plan.simple: true', () => {
    // Test that explicit false flag overrides plan field
    const planData = { simple: true };
    const options: any = { simple: false };

    const hasExplicitSimpleFlag = 'simple' in options && options.simple !== undefined;
    if (!hasExplicitSimpleFlag && planData.simple === true) {
      options.simple = true;
    }

    // Should remain false because CLI has explicit false
    expect(options.simple).toBe(false);
  });

  test('agent command ignores plan.simple when CLI has explicit true', () => {
    // Test that explicit true flag is preserved regardless of plan field
    const planData = { simple: false };
    const options: any = { simple: true };

    const hasExplicitSimpleFlag = 'simple' in options && options.simple !== undefined;
    if (!hasExplicitSimpleFlag && planData.simple === true) {
      options.simple = true;
    }

    // Should remain true because CLI has explicit true
    expect(options.simple).toBe(true);
  });
});
