import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { extractMarkdownToYaml } from './process_markdown.js';
import type { PlanSchema } from './planSchema.js';
import type { TimConfig } from './configSchema.js';

describe('extractMarkdownToYaml container normalization', () => {
  let tempDir: string;
  let tasksDir: string;
  const testConfig: TimConfig = {
    paths: {
      tasks: '',
    },
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-container-update-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    testConfig.paths.tasks = tasksDir;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('preserves container -> epic when updating a plan from YAML', async () => {
    const originalPlan: PlanSchema = {
      id: 1,
      title: 'Original Plan',
      goal: 'Original goal',
      details: 'Original details',
      status: 'pending',
      epic: false,
      tasks: [
        {
          title: 'Existing Task',
          description: 'Existing task description',
          done: true,
        },
      ],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    const outputPath = path.join(tasksDir, '1.plan.md');
    const inputYaml = `id: 1
title: Updated Plan
goal: Updated goal
container: true
tasks:
  - title: New Task
    description: New task description
`;

    await extractMarkdownToYaml(inputYaml, testConfig, true, {
      output: outputPath,
      updatePlan: { data: originalPlan, path: outputPath },
    });

    const updatedContent = await fs.readFile(outputPath, 'utf-8');
    expect(updatedContent.startsWith('---\n')).toBe(true);

    const endDelimiterIndex = updatedContent.indexOf('\n---\n', 4);
    expect(endDelimiterIndex).toBeGreaterThan(0);

    const frontMatter = updatedContent.substring(4, endDelimiterIndex);
    const frontMatterData = yaml.parse(frontMatter);

    expect(frontMatterData.epic).toBe(true);
    expect(frontMatterData.container).toBeUndefined();
  });
});
