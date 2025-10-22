import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleAddImplementationNoteCommand } from './add-implementation-note.js';
import type { PlanSchema } from '../planSchema.js';
import { readPlanFile, clearPlanCache } from '../plans.js';

describe('handleAddImplementationNoteCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    clearPlanCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-add-implementation-note-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('adds implementation note to a plan without existing details', async () => {
    const plan: PlanSchema = {
      id: 101,
      title: 'Test Plan',
      goal: 'Test goal',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '101.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await handleAddImplementationNoteCommand(
      planFile,
      'Implemented user authentication using JWT',
      {
        parent: { opts: () => ({}) },
        opts: () => ({}),
      } as any
    );

    const updated = await readPlanFile(planFile);
    expect(updated.details).toContain('# Implementation Notes');
    expect(updated.details).toContain('Implemented user authentication using JWT');
  });

  test('adds implementation note to a plan with existing details', async () => {
    const plan: PlanSchema = {
      id: 102,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Some existing details about the plan.',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '102.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await handleAddImplementationNoteCommand(planFile, 'Added password validation logic', {
      parent: { opts: () => ({}) },
      opts: () => ({}),
    } as any);

    const updated = await readPlanFile(planFile);
    expect(updated.details).toContain('Some existing details about the plan.');
    expect(updated.details).toContain('# Implementation Notes');
    expect(updated.details).toContain('Added password validation logic');
  });

  test('appends to existing Implementation Notes section', async () => {
    const plan: PlanSchema = {
      id: 103,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Details\n\n# Implementation Notes\n\nFirst note',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '103.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await handleAddImplementationNoteCommand(planFile, 'Second note', {
      parent: { opts: () => ({}) },
      opts: () => ({}),
    } as any);

    const updated = await readPlanFile(planFile);
    expect(updated.details).toContain('First note');
    expect(updated.details).toContain('Second note');
    // Should only have one "# Implementation Notes" header
    expect((updated.details?.match(/# Implementation Notes/g) || []).length).toBe(1);
  });

  test('throws for non-existent plan file or ID', async () => {
    await expect(
      handleAddImplementationNoteCommand(path.join(tasksDir, 'nope.yml'), 'text', {
        parent: { opts: () => ({}) },
        opts: () => ({}),
      } as any)
    ).rejects.toThrow();
  });

  test('throws for empty note string', async () => {
    const plan: PlanSchema = {
      id: 104,
      title: 'Test Plan',
      goal: 'Test goal',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '104.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await expect(
      handleAddImplementationNoteCommand(planFile, '   ', {
        parent: { opts: () => ({}) },
        opts: () => ({}),
      } as any)
    ).rejects.toThrow('You must provide a non-empty implementation note');
  });

  test('creates Implementation Notes section at the bottom', async () => {
    const plan: PlanSchema = {
      id: 105,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Existing details\n\n# Other Section\n\nSome content',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '105.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await handleAddImplementationNoteCommand(planFile, 'New implementation note', {
      parent: { opts: () => ({}) },
      opts: () => ({}),
    } as any);

    const updated = await readPlanFile(planFile);
    // Should come after Other Section
    const detailsText = updated.details || '';
    const otherSectionIndex = detailsText.indexOf('# Other Section');
    const implementationNotesIndex = detailsText.indexOf('# Implementation Notes');
    expect(implementationNotesIndex).toBeGreaterThan(otherSectionIndex);
  });
});
