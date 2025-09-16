import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleAddProgressNoteCommand } from './add-progress-note.js';
import type { PlanSchema } from '../planSchema.js';
import { readPlanFile, clearPlanCache } from '../plans.js';

describe('handleAddProgressNoteCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    clearPlanCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-add-progress-note-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('adds a progress note to a plan without existing notes', async () => {
    const plan: PlanSchema = {
      id: 101,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Details',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '101.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await handleAddProgressNoteCommand(planFile, 'Initial work completed', {
      parent: { opts: () => ({}) },
      opts: () => ({}),
    } as any);

    const updated = await readPlanFile(planFile);
    expect(updated.progressNotes?.length).toBe(1);
    expect(updated.progressNotes?.[0].text).toBe('Initial work completed');
    expect(Date.parse(updated.progressNotes?.[0].timestamp || '')).not.toBeNaN();
  });

  test('preserves existing notes and appends new one', async () => {
    const plan: any = {
      id: 102,
      title: 'Plan',
      goal: 'Goal',
      details: 'Details',
      tasks: [],
      progressNotes: [
        { timestamp: new Date('2024-01-01T00:00:00.000Z').toISOString(), text: 'Old note' },
      ],
    };
    const planFile = path.join(tasksDir, '102.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await handleAddProgressNoteCommand(planFile, 'New discovery', {
      parent: { opts: () => ({}) },
      opts: () => ({}),
    } as any);

    const updated = await readPlanFile(planFile);
    expect(updated.progressNotes?.length).toBe(2);
    expect(updated.progressNotes?.[0].text).toBe('Old note');
    expect(updated.progressNotes?.[1].text).toBe('New discovery');
  });

  test('throws for non-existent plan file or ID', async () => {
    await expect(
      handleAddProgressNoteCommand(path.join(tasksDir, 'nope.yml'), 'text', {
        parent: { opts: () => ({}) },
        opts: () => ({}),
      } as any)
    ).rejects.toThrow();
  });

  test('throws for empty note string', async () => {
    const plan: PlanSchema = {
      id: 103,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Details',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '103.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await expect(
      handleAddProgressNoteCommand(planFile, '   ', {
        parent: { opts: () => ({}) },
        opts: () => ({}),
      } as any)
    ).rejects.toThrow('You must provide a non-empty progress note');
  });

  test('resolves plan by numeric ID using configured tasks dir', async () => {
    // Write config pointing tasks to our temp tasksDir
    const configDir = path.join(tempDir, '.rmfilter');
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, 'rmplan.yml');
    await fs.writeFile(configPath, yaml.stringify({ paths: { tasks: tasksDir } }));

    const plan: PlanSchema = {
      id: 777,
      title: 'ID Plan',
      goal: 'Goal',
      details: 'Details',
      tasks: [],
    };
    await fs.writeFile(path.join(tasksDir, '777.yml'), yaml.stringify(plan));

    await handleAddProgressNoteCommand('777', 'Note via ID', {
      parent: { opts: () => ({ config: configPath }) },
      opts: () => ({}),
    } as any);

    const updated = await readPlanFile(path.join(tasksDir, '777.yml'));
    expect(updated.progressNotes?.length).toBe(1);
    expect(updated.progressNotes?.[0].text).toBe('Note via ID');
  });

  test('fails when plan ID is duplicated across files', async () => {
    // Write config pointing tasks to our temp tasksDir
    const configDir = path.join(tempDir, '.rmfilter');
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, 'rmplan.yml');
    await fs.writeFile(configPath, yaml.stringify({ paths: { tasks: tasksDir } }));

    const dupPlanA: PlanSchema = {
      id: 42,
      title: 'Dup A',
      goal: 'Goal',
      details: 'Details',
      tasks: [],
    };
    const subdirA = path.join(tasksDir, 'subA');
    const subdirB = path.join(tasksDir, 'subB');
    await fs.mkdir(subdirA, { recursive: true });
    await fs.mkdir(subdirB, { recursive: true });
    await fs.writeFile(path.join(subdirA, '42.yml'), yaml.stringify(dupPlanA));
    await fs.writeFile(
      path.join(subdirB, '42.yml'),
      yaml.stringify({ ...dupPlanA, title: 'Dup B' })
    );

    await expect(
      handleAddProgressNoteCommand('42', 'Should fail', {
        parent: { opts: () => ({ config: configPath }) },
        opts: () => ({}),
      } as any)
    ).rejects.toThrow(/duplicated in multiple files/i);
  });

  test('stores source metadata when provided', async () => {
    const plan: PlanSchema = {
      id: 104,
      title: 'Source Plan',
      goal: 'Test source field',
      details: 'Details',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '104.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    const command = {
      parent: { opts: () => ({}) },
      opts: () => ({ source: ' implementer: Task Alpha ' }),
    } as any;

    await handleAddProgressNoteCommand(planFile, 'Documented progress with source', command);

    const updated = await readPlanFile(planFile);
    expect(updated.progressNotes?.[0].source).toBe('implementer: Task Alpha');
  });
});
