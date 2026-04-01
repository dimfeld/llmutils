import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  findTaskByTitle,
  promptForTaskInfo,
  selectTaskInteractive,
  type Task,
} from './task_operations.js';
import { input, select, editor } from '@inquirer/prompts';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  input: vi.fn(),
  editor: vi.fn(),
}));

const selectSpy = vi.mocked(select);
const inputSpy = vi.mocked(input);
const editorSpy = vi.mocked(editor);

describe('task_operations utilities', () => {
  let originalRows: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalRows = typeof process.stdout.rows === 'number' ? process.stdout.rows : undefined;
    Object.defineProperty(process.stdout, 'rows', {
      configurable: true,
      value: 24,
      writable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalRows === undefined) {
      delete (process.stdout as any).rows;
    } else {
      Object.defineProperty(process.stdout, 'rows', {
        configurable: true,
        value: originalRows,
        writable: true,
      });
    }
  });

  describe('findTaskByTitle', () => {
    const tasks: Task[] = [
      { title: 'Improve logging', description: 'Add structured logs', done: false },
      { title: 'Write Tests', description: 'Add coverage', done: false },
      { title: 'Refactor API layer', description: 'Simplify handlers', done: true },
    ];

    test('returns index for exact match', () => {
      expect(findTaskByTitle(tasks, 'Write Tests')).toBe(1);
    });

    test('returns index for partial match case-insensitively', () => {
      expect(findTaskByTitle(tasks, 'api')).toBe(2);
      expect(findTaskByTitle(tasks, 'LOG')).toBe(0);
    });

    test('returns -1 when no match', () => {
      expect(findTaskByTitle(tasks, 'security')).toBe(-1);
    });
  });

  describe('selectTaskInteractive', () => {
    test('returns selected index from prompt', async () => {
      selectSpy.mockResolvedValue(1);

      const tasks: Task[] = [
        { title: 'Task A', description: 'A', done: false },
        { title: 'Task B', description: 'B', done: true },
      ];

      const index = await selectTaskInteractive(tasks);
      expect(index).toBe(1);
      expect(selectSpy).toHaveBeenCalledTimes(1);
    });

    test('throws when plan has no tasks', async () => {
      await expect(selectTaskInteractive([])).rejects.toThrow('Plan has no tasks to select from.');
    });
  });

  describe('promptForTaskInfo', () => {
    test('collects task details via prompts', async () => {
      const responses = {
        title: 'New Feature',
        description: 'Implement feature',
        files: 'src/index.ts, src/utils.ts',
        docs: 'docs/feature.md',
      };

      const inputQueue = [responses.title, responses.files];
      inputSpy.mockImplementation(async (opts: { message: string }) => {
        if (opts.message.startsWith('Related docs')) {
          return responses.docs;
        }
        const value = inputQueue.shift();
        return value ?? '';
      });
      editorSpy.mockResolvedValue(responses.description);

      const result = await promptForTaskInfo();
      expect(result.title).toBe('New Feature');
      expect(result.description).toBe('Implement feature');
    });

    test('throws when editor returns empty description', async () => {
      const inputQueue = ['Another Task', ''];
      inputSpy.mockImplementation(async (opts: { message: string }) => {
        if (opts.message.startsWith('Related docs')) {
          return '';
        }
        const value = inputQueue.shift();
        return value ?? '';
      });
      editorSpy.mockResolvedValue('   ');

      await expect(promptForTaskInfo()).rejects.toThrow('Task description cannot be empty.');
    });
  });
});
