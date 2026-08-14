import { describe, expect, it } from 'vitest';
import { createOrderedClaudeCleanup } from './claude_execution_cleanup.ts';

describe('createOrderedClaudeCleanup', () => {
  it('runs every step in order, shares cleanup, and reports the first error', async () => {
    const events: string[] = [];
    const firstError = new Error('first cleanup failure');
    const cleanup = createOrderedClaudeCleanup([
      (): void => {
        events.push('input');
        throw firstError;
      },
      async (): Promise<void> => {
        events.push('monitor');
      },
      (): void => {
        events.push('mcp');
      },
    ]);

    const first = cleanup.cleanup();
    const second = cleanup.cleanup();

    expect(cleanup.started).toBe(true);
    expect(first).toBe(second);
    await expect(first).rejects.toBe(firstError);
    expect(events).toEqual(['input', 'monitor', 'mcp']);
  });

  it('continues after an asynchronous failure and does not rerun steps', async () => {
    const events: string[] = [];
    const cleanup = createOrderedClaudeCleanup([
      async (): Promise<void> => {
        events.push('socket');
        throw new Error('socket failure');
      },
      (): void => {
        events.push('directory');
      },
    ]);

    await expect(cleanup.cleanup()).rejects.toThrow('socket failure');
    await expect(cleanup.cleanup()).rejects.toThrow('socket failure');
    expect(events).toEqual(['socket', 'directory']);
  });
});
