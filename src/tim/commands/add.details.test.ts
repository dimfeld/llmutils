import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleAddCommand } from './add.js';
import { readPlanFile, clearPlanCache } from '../plans.js';

describe('tim add with details', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;

  beforeEach(async () => {
    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-test-add-details-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Create config file that points to tasks directory
    configPath = path.join(tempDir, '.rmfilter', 'tim.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: {
          tasks: tasksDir,
        },
      })
    );

    clearPlanCache();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('should add plan with inline details', async () => {
    const title = ['Test', 'Plan'];
    const details = '## Overview\nThis is a test plan\n\n## Details\nWith multiple sections';
    const options = {
      details,
    };
    const command = {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };

    await handleAddCommand(title, options, command);

    // Find the created plan file
    const files = await fs.readdir(tasksDir);
    expect(files.length).toBe(1);

    const planFile = path.join(tasksDir, files[0]);
    const plan = await readPlanFile(planFile);

    expect(plan.title).toBe('Test Plan');
    expect(plan.details).toBe(details);
  });

  test('should add plan with details from file', async () => {
    const title = ['Test', 'Plan'];
    const detailsContent =
      '## Research\nFound important information\n\n## Approach\nDo this and that';

    // Create details file
    const detailsFile = path.join(tempDir, 'details.md');
    await fs.writeFile(detailsFile, detailsContent);

    const options = {
      detailsFile,
    };
    const command = {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };

    await handleAddCommand(title, options, command);

    const files = await fs.readdir(tasksDir);
    const planFiles = files.filter((f) => f.endsWith('.plan.md'));
    expect(planFiles.length).toBe(1);

    const planFile = path.join(tasksDir, planFiles[0]);
    const plan = await readPlanFile(planFile);

    expect(plan.title).toBe('Test Plan');
    expect(plan.details).toBe(detailsContent);
  });

  test('should work without details (existing behavior)', async () => {
    const title = ['Test', 'Plan'];
    const options = {};
    const command = {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };

    await handleAddCommand(title, options, command);

    const files = await fs.readdir(tasksDir);
    expect(files.length).toBe(1);

    const planFile = path.join(tasksDir, files[0]);
    const plan = await readPlanFile(planFile);

    expect(plan.title).toBe('Test Plan');
    expect(plan.details).toBe('');
  });

  test('should handle multiline details with special characters', async () => {
    const title = ['Test', 'Plan'];
    const details =
      '## Code Example\n```typescript\nconst x = { foo: "bar" };\n```\n\n## Notes\n- Item 1\n- Item 2';
    const options = {
      details,
    };
    const command = {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };

    await handleAddCommand(title, options, command);

    const files = await fs.readdir(tasksDir);
    expect(files.length).toBe(1);

    const planFile = path.join(tasksDir, files[0]);
    const plan = await readPlanFile(planFile);

    expect(plan.details).toBe(details);
  });

  test('should handle empty details string', async () => {
    const title = ['Test', 'Plan'];
    const options = {
      details: '',
    };
    const command = {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };

    await handleAddCommand(title, options, command);

    const files = await fs.readdir(tasksDir);
    expect(files.length).toBe(1);

    const planFile = path.join(tasksDir, files[0]);
    const plan = await readPlanFile(planFile);

    expect(plan.title).toBe('Test Plan');
    expect(plan.details).toBe('');
  });

  test('should handle details from file with YAML-like content', async () => {
    const title = ['Test', 'Plan'];
    const detailsContent = '## Config\n```yaml\nkey: value\nlist:\n  - item1\n  - item2\n```';

    const detailsFile = path.join(tempDir, 'details.md');
    await fs.writeFile(detailsFile, detailsContent);

    const options = {
      detailsFile,
    };
    const command = {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };

    await handleAddCommand(title, options, command);

    const files = await fs.readdir(tasksDir);
    const planFiles = files.filter((f) => f.endsWith('.plan.md'));
    expect(planFiles.length).toBe(1);

    const planFile = path.join(tasksDir, planFiles[0]);
    const plan = await readPlanFile(planFile);

    expect(plan.title).toBe('Test Plan');
    expect(plan.details).toBe(detailsContent);
  });

  test('should combine details with other options', async () => {
    const title = ['Test', 'Plan'];
    const details = '## Overview\nThis is a high priority plan';
    const options = {
      details,
      priority: 'high',
      status: 'in_progress',
      temp: true,
    };
    const command = {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };

    await handleAddCommand(title, options, command);

    const files = await fs.readdir(tasksDir);
    expect(files.length).toBe(1);

    const planFile = path.join(tasksDir, files[0]);
    const plan = await readPlanFile(planFile);

    expect(plan.title).toBe('Test Plan');
    expect(plan.details).toBe(details);
    expect(plan.priority).toBe('high');
    expect(plan.status).toBe('in_progress');
    expect(plan.temp).toBe(true);
  });

  test('should throw error if details file does not exist', async () => {
    const title = ['Test', 'Plan'];
    const options = {
      detailsFile: path.join(tempDir, 'nonexistent.md'),
    };
    const command = {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };

    await expect(handleAddCommand(title, options, command)).rejects.toThrow();
  });
});
