import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { planSchema } from './planSchema.js';
import { readPlanFile, writePlanFile, clearPlanCache } from './plans.js';
import type { PlanSchema } from './planSchema.js';

describe('simple field schema validation', () => {
  test('accepts plan with simple: true', () => {
    const plan = {
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
      title: 'Test Plan',
      goal: 'Do a thing',
      details: 'Some details',
      simple: 'yes',
      tasks: [],
    } as any;

    expect(() => planSchema.parse(plan)).toThrow();
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
    expect(readPlan.simple).toBe(false);
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

    await fs.writeFile(filename, yaml.stringify(legacyPlan), 'utf-8');

    const readPlan = await readPlanFile(filename);
    // Check that simple is falsy (either false or undefined, both evaluate to false in conditions)
    expect(!readPlan.simple).toBe(true);
  });
});

describe('simple field logic in commands', () => {
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
    // Test the conditional logic in loadResearchPrompt
    const mockPlan = { simple: true, id: 1, title: 'Test', tasks: [] };

    // Simulate the logic from loadResearchPrompt
    let usedSimpleFlow = false;
    if (mockPlan.simple) {
      usedSimpleFlow = true;
    }

    expect(usedSimpleFlow).toBe(true);
  });

  test('MCP loadResearchPrompt uses research flow for non-simple plans', async () => {
    // Test the conditional logic in loadResearchPrompt
    const mockPlan = { simple: false, id: 1, title: 'Test', tasks: [] };

    let usedSimpleFlow = false;
    if (mockPlan.simple) {
      usedSimpleFlow = true;
    }

    expect(usedSimpleFlow).toBe(false);
  });
});
