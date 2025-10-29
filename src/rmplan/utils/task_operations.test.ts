import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ModuleMocker } from '../../testing.js';
import {
  findTaskByTitle,
  promptForTaskInfo,
  selectTaskInteractive,
  type Task,
} from './task_operations.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('task_operations utilities', () => {
  let originalRows: number | undefined;

  beforeEach(() => {
    moduleMocker.clear();
    originalRows = typeof process.stdout.rows === 'number' ? process.stdout.rows : undefined;
    Object.defineProperty(process.stdout, 'rows', {
      configurable: true,
      value: 24,
      writable: true,
    });
  });

  afterEach(() => {
    moduleMocker.clear();
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
      const selectSpy = mock(async () => 1);
      await moduleMocker.mock('@inquirer/prompts', () => ({
        select: selectSpy,
      }));

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
      const inputSpy = mock(async (opts: { message: string }) => {
        if (opts.message.startsWith('Related docs')) {
          return responses.docs;
        }
        const value = inputQueue.shift();
        return value ?? '';
      });
      const editorSpy = mock(async () => responses.description);

      await moduleMocker.mock('@inquirer/prompts', () => ({
        input: inputSpy,
        editor: editorSpy,
      }));

      const result = await promptForTaskInfo();
      expect(result.title).toBe('New Feature');
      expect(result.description).toBe('Implement feature');
      expect(result.files).toEqual(['src/index.ts', 'src/utils.ts']);
      expect(result.docs).toEqual(['docs/feature.md']);
    });

    test('throws when editor returns empty description', async () => {
      const inputQueue = ['Another Task', ''];
      const inputSpy = mock(async (opts: { message: string }) => {
        if (opts.message.startsWith('Related docs')) {
          return '';
        }
        const value = inputQueue.shift();
        return value ?? '';
      });
      const editorSpy = mock(async () => '   ');

      await moduleMocker.mock('@inquirer/prompts', () => ({
        input: inputSpy,
        editor: editorSpy,
      }));

      await expect(promptForTaskInfo()).rejects.toThrow('Task description cannot be empty.');
    });
  });
});
