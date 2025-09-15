import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleAddProgressNoteCommand } from './add-progress-note.js';
import type { PlanSchema } from '../planSchema.js';
import { readPlanFile, clearPlanCache } from '../plans.js';

describe('add-progress-note rotation with maxStored', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;

  beforeEach(async () => {
    clearPlanCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-add-progress-note-rotation-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Write config enabling rotation
    const configDir = path.join(tempDir, '.rmfilter');
    await fs.mkdir(configDir, { recursive: true });
    configPath = path.join(configDir, 'rmplan.yml');
    await fs.writeFile(
      configPath,
      yaml.stringify({ paths: { tasks: tasksDir }, progressNotes: { maxStored: 3 } })
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('oldest notes are discarded when exceeding maxStored', async () => {
    const plan: PlanSchema = {
      id: 901,
      title: 'Rotation Plan',
      goal: 'Test rotation',
      details: 'Details',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '901.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    const cmd = { parent: { opts: () => ({ config: configPath }) } } as any;
    // Add 5 notes; with maxStored 3 only last 3 should remain
    await handleAddProgressNoteCommand('901', 'note-1', cmd);
    await handleAddProgressNoteCommand('901', 'note-2', cmd);
    await handleAddProgressNoteCommand('901', 'note-3', cmd);
    await handleAddProgressNoteCommand('901', 'note-4', cmd);
    await handleAddProgressNoteCommand('901', 'note-5', cmd);

    const updated = await readPlanFile(planFile);
    const texts = (updated.progressNotes || []).map((n) => n.text);
    expect(texts).toEqual(['note-3', 'note-4', 'note-5']);
  });
});
