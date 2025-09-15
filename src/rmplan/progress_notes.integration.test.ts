import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { ModuleMocker } from '../testing.js';
import { clearPlanCache, readPlanFile } from './plans.js';
import type { PlanSchema } from './planSchema.js';

// Dynamic imports for handlers that depend on mocked modules
let handleShowCommand: any;
let handleDoneCommand: any;
let buildExecutionPromptWithoutSteps: any;
let handleAddProgressNoteCommand: any;

describe('Progress Notes Integration', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;
  const moduleMocker = new ModuleMocker(import.meta);
  const mockLog = mock(() => {});

  beforeEach(async () => {
    clearPlanCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-progress-notes-int-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Create config
    configPath = path.join(tempDir, '.rmfilter', 'rmplan.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, yaml.stringify({ paths: { tasks: 'tasks' } }));

    // Mocks
    mockLog.mockClear();
    await moduleMocker.mock('../logging.js', () => ({
      log: mockLog,
      error: mockLog,
      warn: mockLog,
    }));
    await moduleMocker.mock('../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    // Import after mocks
    ({ handleShowCommand } = await import('./commands/show.js'));
    ({ handleDoneCommand } = await import('./commands/done.js'));
    ({ buildExecutionPromptWithoutSteps } = await import('./prompt_builder.js'));
    ({ handleAddProgressNoteCommand } = await import('./commands/add-progress-note.js'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    moduleMocker.clear();
  });

  test('flow: add-progress-note -> file -> show -> prompt', async () => {
    // Create a simple plan
    const plan: PlanSchema = {
      id: 201,
      title: 'Progress Notes Plan',
      goal: 'Ensure notes flow end-to-end',
      details: 'Details',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '201.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    // Add two progress notes
    await handleAddProgressNoteCommand('201', 'Initial chunk completed', {
      parent: { opts: () => ({ config: configPath }) },
    } as any);
    await handleAddProgressNoteCommand('201', 'Found edge case; updated approach', {
      parent: { opts: () => ({ config: configPath }) },
    } as any);

    // Verify file contains notes
    const updated = await readPlanFile(planFile);
    expect(updated.progressNotes?.length).toBe(2);
    expect(updated.progressNotes?.[0].text).toBe('Initial chunk completed');
    expect(updated.progressNotes?.[1].text).toBe('Found edge case; updated approach');

    // Show output contains progress notes section and count
    const showCmd = { parent: { opts: () => ({ config: configPath }) } } as any;
    mockLog.mockClear();
    await handleShowCommand('201', {}, showCmd);
    const out = mockLog.mock.calls.flat().map(String).join('\n');
    expect(out).toContain('Progress Notes: 2');
    expect(out).toContain('Found edge case; updated approach');
    // Should show a date (timestamp displayed in show)
    expect(out).toMatch(/\d{1,2}\/\d{1,2}\/\d{2,4}/);

    // Build prompt and validate notes appear without timestamps
    const prompt = await buildExecutionPromptWithoutSteps({
      executor: { execute: async () => {} },
      planData: updated,
      planFilePath: planFile,
      baseDir: tempDir,
      config: { paths: { tasks: 'tasks' } },
    });
    expect(prompt).toContain('## Progress Notes');
    expect(prompt).toContain('- Initial chunk completed');
    expect(prompt).toContain('- Found edge case; updated approach');
    // No ISO timestamps in the prompt
    expect(prompt).not.toMatch(/T\d{2}:\d{2}:\d{2}/);
  });

  test('multiple additions (simulated agents) append without conflicts and survive plan updates', async () => {
    const plan: PlanSchema = {
      id: 202,
      title: 'Concurrent-ish Notes Plan',
      goal: 'Test multiple additions',
      details: 'Details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task',
          description: 'Desc',
          done: false,
          steps: [{ prompt: 'Step', done: false }],
        },
      ],
    };
    const planFile = path.join(tasksDir, '202.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    // Two sequential additions, like two agents finishing work
    await handleAddProgressNoteCommand('202', 'Agent A: implemented core logic', {
      parent: { opts: () => ({ config: configPath }) },
    } as any);
    await handleAddProgressNoteCommand('202', 'Agent B: added tests and fixes', {
      parent: { opts: () => ({ config: configPath }) },
    } as any);

    let updated = await readPlanFile(planFile);
    expect(updated.progressNotes?.map((n) => n.text)).toEqual([
      'Agent A: implemented core logic',
      'Agent B: added tests and fixes',
    ]);

    // Now perform a plan update (mark a step done) and verify notes persist
    const doneCmd = { parent: { opts: () => ({ config: configPath }) } } as any;
    await handleDoneCommand('202', { steps: '1' }, doneCmd);
    updated = await readPlanFile(planFile);
    expect(updated.tasks?.[0].steps?.[0].done).toBe(true);
    expect(updated.progressNotes?.map((n) => n.text)).toEqual([
      'Agent A: implemented core logic',
      'Agent B: added tests and fixes',
    ]);
  });
});
