import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleSetCommand } from './set.js';
import { clearPlanCache, readPlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock console functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});

describe('handleSetCommand', () => {
  let tempDir: string;
  let tasksDir: string;
  let testPlanFile: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-set-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Create a test plan file
    const testPlan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      priority: 'medium',
      dependencies: ['2'],
      rmfilter: ['src/**/*.ts'],
      tasks: [
        {
          title: 'Test Task',
          description: 'Test task description',
          files: [],
          steps: [{ prompt: 'Test step prompt', done: false }],
        },
      ],
    };

    testPlanFile = path.join(tasksDir, '1.yml');
    const yamlContent = yaml.stringify(testPlan);
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';
    await fs.writeFile(testPlanFile, schemaLine + yamlContent);

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: mock(() => {}),
    }));

    // Mock config loader
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
      }),
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('updates priority correctly', async () => {
    const options = { priority: 'high' as const };
    const command = { parent: { opts: () => ({}) } };

    await handleSetCommand('1', options, command);

    const updatedPlan = await readPlanFile(testPlanFile);
    expect(updatedPlan.priority).toBe('high');
    expect(updatedPlan.updatedAt).toBeDefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('priority: high'));
  });

  test('updates status correctly', async () => {
    const options = { status: 'in_progress' as const };
    const command = { parent: { opts: () => ({}) } };

    await handleSetCommand('1', options, command);

    const updatedPlan = await readPlanFile(testPlanFile);
    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.updatedAt).toBeDefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('status: in_progress'));
  });

  test('adds dependencies correctly', async () => {
    const options = { dependsOn: ['3', '4'] };
    const command = { parent: { opts: () => ({}) } };

    await handleSetCommand('1', options, command);

    const updatedPlan = await readPlanFile(testPlanFile);
    expect(updatedPlan.dependencies).toEqual(['2', '3', '4']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('added dependency: 3'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('added dependency: 4'));
  });

  test('removes dependencies correctly', async () => {
    const options = { noDependsOn: ['2'] };
    const command = { parent: { opts: () => ({}) } };

    await handleSetCommand('1', options, command);

    const updatedPlan = await readPlanFile(testPlanFile);
    expect(updatedPlan.dependencies).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('removed dependency: 2'));
  });

  test('handles adding and removing dependencies in the same command', async () => {
    const options = { dependsOn: ['3'], noDependsOn: ['2'] };
    const command = { parent: { opts: () => ({}) } };

    await handleSetCommand('1', options, command);

    const updatedPlan = await readPlanFile(testPlanFile);
    expect(updatedPlan.dependencies).toEqual(['3']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('removed dependency: 2'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('added dependency: 3'));
  });

  test('updates rmfilter correctly', async () => {
    const options = { rmfilter: ['src/**/*.js', 'tests/**/*.ts'] };
    const command = { parent: { opts: () => ({}) } };

    await handleSetCommand('1', options, command);

    const updatedPlan = await readPlanFile(testPlanFile);
    expect(updatedPlan.rmfilter).toEqual(['src/**/*.js', 'tests/**/*.ts']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('rmfilter: [src/**/*.js, tests/**/*.ts]'));
  });

  test('handles multiple updates in one command', async () => {
    const options = {
      priority: 'urgent' as const,
      status: 'done' as const,
      dependsOn: ['5'],
      rmfilter: ['new/**/*.ts'],
    };
    const command = { parent: { opts: () => ({}) } };

    await handleSetCommand('1', options, command);

    const updatedPlan = await readPlanFile(testPlanFile);
    expect(updatedPlan.priority).toBe('urgent');
    expect(updatedPlan.status).toBe('done');
    expect(updatedPlan.dependencies).toEqual(['2', '5']);
    expect(updatedPlan.rmfilter).toEqual(['new/**/*.ts']);
    expect(updatedPlan.updatedAt).toBeDefined();
  });

  test('does nothing when no options are provided', async () => {
    const options = {};
    const command = { parent: { opts: () => ({}) } };

    await handleSetCommand('1', options, command);

    expect(logSpy).toHaveBeenCalledWith('No changes made to the plan');
  });

  test('handles plan without existing dependencies', async () => {
    // Create a plan without dependencies
    const planWithoutDeps: PlanSchema = {
      id: '2',
      title: 'Plan without deps',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      tasks: [
        {
          title: 'Test Task',
          description: 'Test task description',
          files: [],
          steps: [{ prompt: 'Test step prompt', done: false }],
        },
      ],
    };

    const planFile2 = path.join(tasksDir, '2.yml');
    const yamlContent = yaml.stringify(planWithoutDeps);
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';
    await fs.writeFile(planFile2, schemaLine + yamlContent);

    const options = { dependsOn: ['1'] };
    const command = { parent: { opts: () => ({}) } };

    await handleSetCommand('2', options, command);

    const updatedPlan = await readPlanFile(planFile2);
    expect(updatedPlan.dependencies).toEqual(['1']);
  });

  test('ignores duplicate dependencies when adding', async () => {
    const options = { dependsOn: ['2', '3'] }; // '2' already exists
    const command = { parent: { opts: () => ({}) } };

    await handleSetCommand('1', options, command);

    const updatedPlan = await readPlanFile(testPlanFile);
    expect(updatedPlan.dependencies).toEqual(['2', '3']);
    // Should only log about adding '3', not '2'
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('added dependency: 3'));
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('added dependency: 2'));
  });

  test('handles non-existent dependency removal gracefully', async () => {
    const options = { noDependsOn: ['999'] }; // doesn't exist
    const command = { parent: { opts: () => ({}) } };

    await handleSetCommand('1', options, command);

    const updatedPlan = await readPlanFile(testPlanFile);
    expect(updatedPlan.dependencies).toEqual(['2']); // unchanged
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('removed dependency: 999'));
  });

  test('adds issue URLs correctly', async () => {
    const options = { issue: ['https://github.com/owner/repo/issues/123', 'https://github.com/owner/repo/issues/124'] };
    const command = { parent: { opts: () => ({}) } };

    await handleSetCommand('1', options, command);

    const updatedPlan = await readPlanFile(testPlanFile);
    expect(updatedPlan.issue).toEqual(['https://github.com/owner/repo/issues/123', 'https://github.com/owner/repo/issues/124']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('added issue: https://github.com/owner/repo/issues/123'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('added issue: https://github.com/owner/repo/issues/124'));
  });

  test('removes issue URLs correctly', async () => {
    // First add some issue URLs
    const setupOptions = { issue: ['https://github.com/owner/repo/issues/123', 'https://github.com/owner/repo/issues/124'] };
    const command = { parent: { opts: () => ({}) } };
    await handleSetCommand('1', setupOptions, command);
    
    // Clear logs
    logSpy.mockClear();
    
    // Now remove one
    const options = { noIssue: ['https://github.com/owner/repo/issues/123'] };
    await handleSetCommand('1', options, command);

    const updatedPlan = await readPlanFile(testPlanFile);
    expect(updatedPlan.issue).toEqual(['https://github.com/owner/repo/issues/124']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('removed issue: https://github.com/owner/repo/issues/123'));
  });

  test('handles adding and removing issue URLs in the same command', async () => {
    // First add some issue URLs
    const setupOptions = { issue: ['https://github.com/owner/repo/issues/123', 'https://github.com/owner/repo/issues/124'] };
    const command = { parent: { opts: () => ({}) } };
    await handleSetCommand('1', setupOptions, command);
    
    // Clear logs
    logSpy.mockClear();
    
    // Add and remove in same command
    const options = { 
      issue: ['https://github.com/owner/repo/issues/125'], 
      noIssue: ['https://github.com/owner/repo/issues/123'] 
    };
    await handleSetCommand('1', options, command);

    const updatedPlan = await readPlanFile(testPlanFile);
    expect(updatedPlan.issue).toEqual(['https://github.com/owner/repo/issues/124', 'https://github.com/owner/repo/issues/125']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('removed issue: https://github.com/owner/repo/issues/123'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('added issue: https://github.com/owner/repo/issues/125'));
  });

  test('ignores duplicate issue URLs when adding', async () => {
    // First add an issue URL
    const setupOptions = { issue: ['https://github.com/owner/repo/issues/123'] };
    const command = { parent: { opts: () => ({}) } };
    await handleSetCommand('1', setupOptions, command);
    
    // Clear logs
    logSpy.mockClear();
    
    // Try to add the same URL again plus a new one
    const options = { issue: ['https://github.com/owner/repo/issues/123', 'https://github.com/owner/repo/issues/124'] };
    await handleSetCommand('1', options, command);

    const updatedPlan = await readPlanFile(testPlanFile);
    expect(updatedPlan.issue).toEqual(['https://github.com/owner/repo/issues/123', 'https://github.com/owner/repo/issues/124']);
    // Should only log about adding the new one
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('added issue: https://github.com/owner/repo/issues/124'));
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('added issue: https://github.com/owner/repo/issues/123'));
  });

  test('handles non-existent issue URL removal gracefully', async () => {
    const options = { noIssue: ['https://github.com/owner/repo/issues/999'] }; // doesn't exist
    const command = { parent: { opts: () => ({}) } };

    await handleSetCommand('1', options, command);

    const updatedPlan = await readPlanFile(testPlanFile);
    expect(updatedPlan.issue).toEqual([]); // empty array
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('removed issue:'));
  });
});