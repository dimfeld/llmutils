import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { ModuleMocker } from '../../testing.js';
import stripAnsi from 'strip-ansi';

let handleListCommand: any;

describe('rmplan list shows progress notes counts', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;
  const moduleMocker = new ModuleMocker(import.meta);
  const mockLog = mock(() => {});

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-list-notes-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    configPath = path.join(tempDir, '.rmfilter', 'rmplan.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, yaml.stringify({ paths: { tasks: 'tasks' } }));

    mockLog.mockClear();
    await moduleMocker.mock('../../logging.js', () => ({
      log: mockLog,
      error: mockLog,
      warn: mockLog,
    }));
    // Make the table output easy to parse
    await moduleMocker.mock('table', () => ({
      table: (data: any[]) => data.map((row: any[]) => row.join('\t')).join('\n'),
    }));
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    ({ handleListCommand } = await import('./list.js'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    moduleMocker.clear();
  });

  test('shows Notes column with per-plan counts when any plan has notes', async () => {
    // Plan with 3 progress notes
    const planWithNotes = {
      id: 10,
      title: 'With Notes',
      goal: 'Test list notes column',
      details: 'Details',
      status: 'pending',
      tasks: [],
      progressNotes: [
        { timestamp: new Date('2024-01-01T00:00:00Z').toISOString(), text: 'A' },
        { timestamp: new Date('2024-01-02T00:00:00Z').toISOString(), text: 'B' },
        { timestamp: new Date('2024-01-03T00:00:00Z').toISOString(), text: 'C' },
      ],
    };
    await fs.writeFile(path.join(tasksDir, '10.yml'), yaml.stringify(planWithNotes));

    // Plan without notes
    const planWithoutNotes = {
      id: 11,
      title: 'No Notes',
      goal: 'Control',
      details: 'Details',
      status: 'pending',
      tasks: [],
    };
    await fs.writeFile(path.join(tasksDir, '11.yml'), yaml.stringify(planWithoutNotes));

    const command = { parent: { opts: () => ({ config: configPath }) } } as any;
    await handleListCommand({ sort: 'id' }, command);

    const out = mockLog.mock.calls.flat().map(String).join('\n');
    const lines = out.split('\n');
    const header = lines[0].split('\t').map(stripAnsi);
    expect(header).toContain('Notes');

    // Find the row for the plan with notes and assert count is shown as 3
    const withNotesRow = lines.find((l) => l.includes('With Notes')) || '';
    const withNotesCols = withNotesRow.split('\t');
    const notesIndex = header.indexOf('Notes');
    expect(notesIndex).toBeGreaterThan(-1);
    expect(withNotesCols[notesIndex]).toBe('3');

    // The other plan should show '-' in the Notes column
    const noNotesRow = lines.find((l) => l.includes('No Notes')) || '';
    const noNotesCols = noNotesRow.split('\t');
    expect(noNotesCols[notesIndex]).toBe('-');
  });

  test('omits Notes column entirely when no plans have notes', async () => {
    const planA = {
      id: 21,
      title: 'Alpha',
      goal: 'No notes',
      details: 'Details',
      status: 'pending',
      tasks: [],
    };
    const planB = {
      id: 22,
      title: 'Beta',
      goal: 'Still no notes',
      details: 'Details',
      status: 'pending',
      tasks: [],
    };
    await fs.writeFile(path.join(tasksDir, '21.yml'), yaml.stringify(planA));
    await fs.writeFile(path.join(tasksDir, '22.yml'), yaml.stringify(planB));

    const command = { parent: { opts: () => ({ config: configPath }) } } as any;
    mockLog.mockClear();
    await handleListCommand({ sort: 'id' }, command);

    const out = mockLog.mock.calls.flat().map(String).join('\n');
    const header = out.split('\n')[0].split('\t');
    expect(header).not.toContain('Notes');
  });
});
