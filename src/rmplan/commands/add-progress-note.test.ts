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
    });

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
    });

    const updated = await readPlanFile(planFile);
    expect(updated.progressNotes?.length).toBe(2);
    expect(updated.progressNotes?.[0].text).toBe('Old note');
    expect(updated.progressNotes?.[1].text).toBe('New discovery');
  });

  test('throws for non-existent plan file or ID', async () => {
    await expect(
      handleAddProgressNoteCommand(path.join(tasksDir, 'nope.yml'), 'text', {
        parent: { opts: () => ({}) },
      })
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
      handleAddProgressNoteCommand(planFile, '   ', { parent: { opts: () => ({}) } })
    ).rejects.toThrow('You must provide a non-empty progress note');
  });
});
