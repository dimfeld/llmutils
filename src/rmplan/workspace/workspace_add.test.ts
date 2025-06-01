import { beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import type { PlanSchema } from '../planSchema.js';

describe('workspace add command - integration', () => {
  let tempDir: string;
  let tasksDir: string;
  let planPath: string;

  beforeEach(async () => {
    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-workspace-test-'));
    tasksDir = path.join(tempDir, 'tasks');

    await fs.mkdir(tasksDir, { recursive: true });

    // Create a test plan file
    const testPlan: PlanSchema = {
      id: 'test-plan-123',
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [
        {
          title: 'Test Task',
          description: 'Test task description',
          steps: [
            {
              prompt: 'Test step',
              done: false,
            },
          ],
        },
      ],
    };

    const planYaml = yaml.stringify(testPlan);
    const planContent = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n${planYaml}`;
    planPath = path.join(tasksDir, 'test-plan.yml');
    await fs.writeFile(planPath, planContent);
  });

  test('YAML parsing with schema comment', async () => {
    // Read original content
    const originalContent = await fs.readFile(planPath, 'utf-8');
    expect(originalContent).toContain('status: pending');
    expect(originalContent).toContain('# yaml-language-server:');

    // Test YAML parsing with schema comment removal
    const yamlContent = originalContent.replace(/^#\s*yaml-language-server:.*$/m, '').trim();
    const plan = yaml.parse(yamlContent) as PlanSchema;

    expect(plan.id).toBe('test-plan-123');
    expect(plan.status).toBe('pending');
    expect(plan.title).toBe('Test Plan');
    expect(plan.goal).toBe('Test goal');
  });

  test('resolvePlanFile works with file paths', async () => {
    const { resolvePlanFile } = await import('../plans.js');

    // Test with absolute path
    const resolved = await resolvePlanFile(planPath, undefined);
    expect(resolved).toBe(planPath);
  });

  test('generateProjectId creates valid IDs', async () => {
    const { generateProjectId } = await import('../id_utils.js');

    const id1 = generateProjectId();
    const id2 = generateProjectId();

    // Should be different
    expect(id1).not.toBe(id2);

    // Should match expected format
    expect(id1).toMatch(/^[a-z0-9-]+$/);
    expect(id1.length).toBeGreaterThan(5); // IDs should be at least 6 characters
  });
});
