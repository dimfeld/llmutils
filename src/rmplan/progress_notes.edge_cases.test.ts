import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { ModuleMocker } from '../testing.js';
import { clearPlanCache, readPlanFile } from './plans.js';
import type { PlanSchema } from './planSchema.js';

let handleShowCommand: any;
let buildExecutionPromptWithoutSteps: any;
let handleAddProgressNoteCommand: any;

describe('Progress Notes Edge Cases', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;
  const moduleMocker = new ModuleMocker(import.meta);
  const mockLog = mock(() => {});

  beforeEach(async () => {
    clearPlanCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-progress-notes-edges-'));
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

    ({ handleShowCommand } = await import('./commands/show.js'));
    ({ buildExecutionPromptWithoutSteps } = await import('./prompt_builder.js'));
    ({ handleAddProgressNoteCommand } = await import('./commands/add-progress-note.js'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    moduleMocker.clear();
  });

  test('very long note is truncated in show (default) and preserved with --full', async () => {
    const plan: PlanSchema = {
      id: 301,
      title: 'Edge: Long Note',
      goal: 'Test truncation',
      details: 'Details',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '301.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    const longText = 'X'.repeat(300) + ' end';
    await handleAddProgressNoteCommand('301', longText, {
      parent: { opts: () => ({ config: configPath }) },
    } as any);

    const showCmd = { parent: { opts: () => ({ config: configPath }) } } as any;
    mockLog.mockClear();
    await handleShowCommand('301', {}, showCmd);
    const out = mockLog.mock.calls.flat().map(String).join('\n');
    // Default show should truncate per-note to 160 chars and add '...'
    expect(out).toMatch(/\n\s*•\s*.*\s+X{157}\.\.\./);

    // --full should include the entire content (not single-line, preserves full text)
    mockLog.mockClear();
    await handleShowCommand('301', { full: true }, showCmd);
    const outFull = mockLog.mock.calls.flat().map(String).join('\n');
    expect(outFull).toContain(longText);
  });

  test('multi-line and special characters are preserved in file, collapsed in prompt', async () => {
    const plan: PlanSchema = {
      id: 302,
      title: 'Edge: Multiline & Special',
      goal: 'Test formatting',
      details: 'Details',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '302.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    const specialMultiline = `Line 1: quotes " ' backticks \` code
Line 2: emoji 🚀 café naïve
Line 3: YAML-ish : & % [ ] { } < >`;
    await handleAddProgressNoteCommand('302', specialMultiline, {
      parent: { opts: () => ({ config: configPath }) },
    } as any);

    // Verify stored text is intact
    const updated = await readPlanFile(planFile);
    expect(updated.progressNotes?.[0].text).toBe(specialMultiline);

    // Default show should present a single-line truncated version
    const showCmd = { parent: { opts: () => ({ config: configPath }) } } as any;
    mockLog.mockClear();
    await handleShowCommand('302', {}, showCmd);
    const out = mockLog.mock.calls.flat().map(String).join('\n');
    expect(out).toContain('Line 1: quotes');
    expect(out).not.toContain('\nLine 2:'); // collapsed to single line

    // Prompt should include a single bullet with whitespace collapsed and no timestamps
    const prompt = await buildExecutionPromptWithoutSteps({
      executor: { execute: async () => {} },
      planData: updated,
      planFilePath: planFile,
      baseDir: tempDir,
      config: { paths: { tasks: 'tasks' } },
    });
    expect(prompt).toContain('## Progress Notes');
    // Collapsed whitespace: spaces instead of newlines; ensure line 2 content is on same bullet line
    expect(prompt).toContain('- Line 1: quotes');
    expect(prompt).toContain('backticks ` code Line 2: emoji');
  });

  test('prompt shows last 10 notes and summary for hidden ones', async () => {
    const plan: PlanSchema = {
      id: 303,
      title: 'Edge: >10 Notes',
      goal: 'Test prompt truncation',
      details: 'Details',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '303.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    // Add 12 notes
    const showCmd = { parent: { opts: () => ({ config: configPath }) } } as any;
    for (let i = 1; i <= 12; i++) {
      // eslint-disable-next-line no-await-in-loop
      await handleAddProgressNoteCommand('303', `Note ${i}`, showCmd);
    }

    const updated = await readPlanFile(planFile);
    expect(updated.progressNotes?.length).toBe(12);

    const prompt = await buildExecutionPromptWithoutSteps({
      executor: { execute: async () => {} },
      planData: updated,
      planFilePath: planFile,
      baseDir: tempDir,
      config: { paths: { tasks: 'tasks' } },
    });

    // Should include notes 3..12 (last 10)
    expect(prompt).not.toMatch(/^\- Note 1$/m);
    expect(prompt).not.toMatch(/^\- Note 2$/m);
    for (let i = 3; i <= 12; i++) {
      expect(prompt).toMatch(new RegExp(`^\\- Note ${i}$`, 'm'));
    }
    expect(prompt).toContain('... and 2 more earlier note(s)');

    // Default show should also show last 10 and summary
    mockLog.mockClear();
    await handleShowCommand('303', {}, showCmd);
    const out = mockLog.mock.calls.flat().map(String).join('\n');
    expect(out).toMatch(/^\s*•\s.*Note 12/m);
    expect(out).not.toMatch(/^\s*•\s.*Note 1$/m);
    expect(out).toContain('and 2 more earlier note(s)');
  });

  test('prompt truncates very long single note lines', async () => {
    const plan: PlanSchema = {
      id: 304,
      title: 'Edge: Prompt Truncation',
      goal: 'Prompt per-note truncation',
      details: 'Details',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '304.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    const longText = 'Y'.repeat(300) + ' END';
    await handleAddProgressNoteCommand('304', longText, {
      parent: { opts: () => ({ config: configPath }) },
    } as any);

    const updated = await readPlanFile(planFile);
    const prompt = await buildExecutionPromptWithoutSteps({
      executor: { execute: async () => {} },
      planData: updated,
      planFilePath: planFile,
      baseDir: tempDir,
      config: { paths: { tasks: 'tasks' } },
    });

    // Prompt should contain truncated bullet (160 chars max, with ...)
    const bulletLine = prompt.split('\n').find((l) => l.startsWith('- ')) as string;
    expect(bulletLine.length).toBeLessThanOrEqual(2 + 160); // '- ' + 160
    expect(bulletLine.endsWith('...')).toBe(true);
  });
});
