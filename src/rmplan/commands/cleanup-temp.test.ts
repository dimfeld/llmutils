import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { handleCleanupTempCommand } from './cleanup-temp.js';

describe('rmplan cleanup-temp command', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-cleanup-temp-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Create config file that points to tasks directory
    const configPath = path.join(tempDir, '.rmfilter', 'rmplan.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: {
          tasks: tasksDir,
        },
      })
    );
  });

  afterEach(async () => {
    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('deletes only plans with temp: true', async () => {
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';

    // Create a temporary plan
    await fs.writeFile(
      path.join(tasksDir, '1-temp-plan.plan.md'),
      schemaLine +
        yaml.stringify({
          id: 1,
          title: 'Temp Plan',
          goal: 'Test goal',
          details: 'Test details',
          status: 'pending',
          temp: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
    );

    // Create a permanent plan
    await fs.writeFile(
      path.join(tasksDir, '2-permanent-plan.plan.md'),
      schemaLine +
        yaml.stringify({
          id: 2,
          title: 'Permanent Plan',
          goal: 'Test goal',
          details: 'Test details',
          status: 'pending',
          temp: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
    );

    // Create a plan without temp field (should be treated as false)
    await fs.writeFile(
      path.join(tasksDir, '3-normal-plan.plan.md'),
      schemaLine +
        yaml.stringify({
          id: 3,
          title: 'Normal Plan',
          goal: 'Test goal',
          details: 'Test details',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
    );

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'rmplan.yml') }),
      },
    };

    await handleCleanupTempCommand({}, command);

    // Verify temp plan was deleted
    const tempPlanExists = await fs
      .access(path.join(tasksDir, '1-temp-plan.plan.md'))
      .then(() => true)
      .catch(() => false);
    expect(tempPlanExists).toBe(false);

    // Verify permanent plan still exists
    const permanentPlanExists = await fs
      .access(path.join(tasksDir, '2-permanent-plan.plan.md'))
      .then(() => true)
      .catch(() => false);
    expect(permanentPlanExists).toBe(true);

    // Verify normal plan still exists
    const normalPlanExists = await fs
      .access(path.join(tasksDir, '3-normal-plan.plan.md'))
      .then(() => true)
      .catch(() => false);
    expect(normalPlanExists).toBe(true);
  });

  test('deletes multiple temporary plans', async () => {
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';

    // Create multiple temporary plans
    for (let i = 1; i <= 3; i++) {
      await fs.writeFile(
        path.join(tasksDir, `${i}-temp-plan-${i}.plan.md`),
        schemaLine +
          yaml.stringify({
            id: i,
            title: `Temp Plan ${i}`,
            goal: 'Test goal',
            details: 'Test details',
            status: 'pending',
            temp: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            tasks: [],
          })
      );
    }

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'rmplan.yml') }),
      },
    };

    await handleCleanupTempCommand({}, command);

    // Verify all temp plans were deleted
    for (let i = 1; i <= 3; i++) {
      const exists = await fs
        .access(path.join(tasksDir, `${i}-temp-plan-${i}.plan.md`))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    }
  });

  test('handles empty directory gracefully', async () => {
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'rmplan.yml') }),
      },
    };

    // Should not throw an error
    await expect(handleCleanupTempCommand({}, command)).resolves.toBeUndefined();
  });

  test('handles directory with no temp plans', async () => {
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';

    // Create only permanent plans
    await fs.writeFile(
      path.join(tasksDir, '1-permanent-plan.plan.md'),
      schemaLine +
        yaml.stringify({
          id: 1,
          title: 'Permanent Plan',
          goal: 'Test goal',
          details: 'Test details',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        })
    );

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'rmplan.yml') }),
      },
    };

    await handleCleanupTempCommand({}, command);

    // Verify permanent plan still exists
    const exists = await fs
      .access(path.join(tasksDir, '1-permanent-plan.plan.md'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });
});
