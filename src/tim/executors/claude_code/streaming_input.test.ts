import { describe, expect, it, vi } from 'vitest';
import type { FileSink } from 'bun';
import type { SpawnAndLogOutputResult, StreamingProcess } from '../../../common/process.ts';
import {
  buildSingleUserInputMessageLine,
  PersistentClaudeInputWriter,
  safeEndStdin,
  sendFollowUpMessage,
  sendInitialPrompt,
} from './streaming_input.ts';

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value: T): void => resolvePromise?.(value),
    reject: (error: unknown): void => rejectPromise?.(error),
  };
}

type MockFileSink = {
  writes: string[];
  endCalls: number;
  write: (chunk: string) => number;
  end: () => Promise<void>;
};

function createMockFileSink(): MockFileSink {
  return {
    writes: [],
    endCalls: 0,
    write(chunk: string): number {
      this.writes.push(chunk);
      return chunk.length;
    },
    async end(): Promise<void> {
      this.endCalls += 1;
    },
  };
}

function createStreamingProcessMock(
  stdin: MockFileSink,
  result: SpawnAndLogOutputResult
): StreamingProcess {
  return {
    stdin: stdin as unknown as FileSink,
    result: Promise.resolve(result),
    kill: () => {},
  };
}

describe('streaming_input multi-message helpers', () => {
  it('sendInitialPrompt writes a stream-json user message and does not close stdin', () => {
    const stdin = createMockFileSink();
    const process = createStreamingProcessMock(stdin, {
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });

    sendInitialPrompt(process, 'Initial instruction');

    expect(stdin.writes).toEqual([buildSingleUserInputMessageLine('Initial instruction')]);
    expect(stdin.endCalls).toBe(0);
  });

  it('sendFollowUpMessage writes an additional stream-json user message', () => {
    const stdin = createMockFileSink();

    sendFollowUpMessage(stdin as unknown as FileSink, 'Add tests too');

    expect(stdin.writes).toEqual([buildSingleUserInputMessageLine('Add tests too')]);
  });

  it('supports multiple messages before close', () => {
    const stdin = createMockFileSink();
    const result: SpawnAndLogOutputResult = {
      exitCode: 0,
      stdout: 'done',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    };
    const process = createStreamingProcessMock(stdin, result);

    sendInitialPrompt(process, 'Initial prompt');
    sendFollowUpMessage(process.stdin, 'Follow-up 1');
    sendFollowUpMessage(process.stdin, 'Follow-up 2');

    expect(stdin.writes).toEqual([
      buildSingleUserInputMessageLine('Initial prompt'),
      buildSingleUserInputMessageLine('Follow-up 1'),
      buildSingleUserInputMessageLine('Follow-up 2'),
    ]);
    expect(stdin.endCalls).toBe(0);
  });

  it('safeEndStdin catches synchronous end errors', async () => {
    const capturedArgs: unknown[][] = [];
    const stdin = {
      write: () => 0,
      end: () => {
        throw new Error('sync end failure');
      },
    } as unknown as FileSink;

    safeEndStdin(stdin, (...args) => {
      capturedArgs.push(args);
    });

    await Promise.resolve();
    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]?.[0]).toBe('Failed to close stdin: %s');
    expect(capturedArgs[0]?.[1]).toBeInstanceOf(Error);
  });

  it('safeEndStdin catches asynchronous end rejections', async () => {
    const capturedArgs: unknown[][] = [];
    const stdin = {
      write: () => 0,
      end: () => Promise.reject(new Error('async end failure')),
    } as unknown as FileSink;

    safeEndStdin(stdin, (...args) => {
      capturedArgs.push(args);
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]?.[0]).toBe('Failed to close stdin: %s');
    expect(capturedArgs[0]?.[1]).toBeInstanceOf(Error);
  });
});

describe('PersistentClaudeInputWriter', () => {
  it('accepts a synchronous write and uses canonical JSONL encoding', () => {
    const stdin = createMockFileSink();
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });
    writer.markReady();

    expect(writer.writeUserMessage('quoted "content" and \\ slash')).toEqual({
      status: 'accepted',
    });
    expect(stdin.writes).toEqual([
      buildSingleUserInputMessageLine('quoted "content" and \\ slash'),
    ]);
    expect(writer.isWriteInProgress).toBe(false);
  });

  it('normalizes an asynchronous write and refuses a second in-flight message', async () => {
    const write = deferred<number>();
    const stdin = {
      writes: [] as string[],
      endCalls: 0,
      write(chunk: string): Promise<number> {
        this.writes.push(chunk);
        return write.promise;
      },
      end(): Promise<void> {
        this.endCalls += 1;
        return Promise.resolve();
      },
    };
    const availability = vi.fn();
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
      onAvailabilityChange: availability,
    });
    writer.markReady();

    const first = writer.writeUserMessage('first');
    expect(first).toBeInstanceOf(Promise);
    expect(writer.writeUserMessage('second')).toEqual({
      status: 'temporarily-unavailable',
      reason: 'write-in-progress',
    });

    write.resolve(1);
    await expect(first).resolves.toEqual({ status: 'accepted' });
    expect(stdin.writes).toHaveLength(1);
    expect(availability).toHaveBeenCalled();
    expect(writer.isWriteInProgress).toBe(false);
  });

  it('reports transport contention without claiming provider state', async () => {
    const write = deferred<number>();
    const stdin = {
      write: vi.fn(() => write.promise),
      end: vi.fn(() => Promise.resolve(0)),
    };
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });
    writer.markReady();

    const first = writer.writeUserMessage('first');
    const second = writer.writeUserMessage('second');
    expect(second).toEqual({
      status: 'temporarily-unavailable',
      reason: 'write-in-progress',
    });
    expect(stdin.write).toHaveBeenCalledTimes(1);

    write.resolve(1);
    await expect(first).resolves.toMatchObject({
      status: 'accepted',
    });
  });

  it('does not restore or change provider state after a rejected write', async () => {
    const firstWrite = deferred<number>();
    const stdin = {
      write: vi.fn(() => firstWrite.promise),
      end: vi.fn(() => Promise.resolve(0)),
    };
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });
    writer.markReady();

    const first = writer.writeUserMessage('first');
    firstWrite.reject(new Error('write failed'));

    await expect(first).resolves.toMatchObject({ status: 'failed' });
    expect(writer.isClosed).toBe(true);
  });

  it('reports a rejected write and invokes the failure callback', async () => {
    const write = deferred<number>();
    const failure = vi.fn();
    const stdin = {
      write: vi.fn(() => write.promise),
      end: vi.fn(() => Promise.resolve(0)),
    };
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
      onWriteFailure: failure,
    });
    writer.markReady();

    const pending = writer.writeUserMessage('first');
    write.reject(new Error('broken pipe'));

    await expect(pending).resolves.toMatchObject({ status: 'failed' });
    expect(failure).toHaveBeenCalledOnce();
  });

  it('returns failed for thrown writes and closed input without queueing', () => {
    const stdin = {
      write: vi.fn(() => {
        throw new Error('broken pipe');
      }),
      end: vi.fn(() => Promise.resolve(0)),
    };
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });
    writer.markReady();

    expect(writer.writeUserMessage('first')).toMatchObject({ status: 'failed' });
    writer.close();
    expect(writer.writeUserMessage('second')).toMatchObject({ status: 'failed' });
    expect(stdin.write).toHaveBeenCalledTimes(1);
    expect(stdin.end).toHaveBeenCalledTimes(1);
  });

  it('keeps spawning input temporarily unavailable until readiness', () => {
    const stdin = createMockFileSink();
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });

    expect(writer.writeUserMessage('initial')).toEqual({
      status: 'temporarily-unavailable',
      reason: 'not-ready',
    });
    expect(stdin.writes).toEqual([]);
    writer.markReady();
    expect(writer.writeUserMessage('initial')).toMatchObject({ status: 'accepted' });
  });

  it('treats a synchronous zero-byte write as accepted (buffered, not an error)', () => {
    const stdin = {
      writes: [] as string[],
      endCalls: 0,
      write(chunk: string): number {
        this.writes.push(chunk);
        // Bun's FileSink.write() can synchronously return 0 when the chunk is
        // buffered internally rather than immediately flushed; this is not a
        // failure and must not be treated as one.
        return 0;
      },
      end(): Promise<void> {
        this.endCalls += 1;
        return Promise.resolve();
      },
    };
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });
    writer.markReady();

    expect(writer.writeUserMessage('buffered')).toEqual({ status: 'accepted' });
    expect(stdin.writes).toEqual([buildSingleUserInputMessageLine('buffered')]);
  });

  it('exposes transport readiness, busy, and closed state only', () => {
    const stdin = createMockFileSink();
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });

    expect(writer.isReady).toBe(false);

    writer.markReady();
    expect(writer.isReady).toBe(true);

    writer.close();
    expect(writer.isClosed).toBe(true);
    expect(writer.isReady).toBe(false);
  });

  it('resolves the ready promise once markReady is called', async () => {
    const stdin = createMockFileSink();
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });

    let settled = false;
    void writer.ready.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    writer.markReady();
    await writer.ready;
    expect(settled).toBe(true);
  });

  it('rejects the ready promise when startup fails before readiness', async () => {
    const stdin = createMockFileSink();
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });

    const failure = new Error('spawn failed');
    writer.fail(failure);

    await expect(writer.ready).rejects.toThrow('spawn failed');
    expect(writer.lastError).toBe(failure);
    expect(writer.isClosed).toBe(true);
  });

  it('records lastError from a write failure via the getter', async () => {
    const write = deferred<number>();
    const stdin = {
      write: vi.fn(() => write.promise),
      end: vi.fn(() => Promise.resolve(0)),
    };
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
      onWriteFailure: () => {},
    });
    writer.markReady();

    const pending = writer.writeUserMessage('will fail');
    const failure = new Error('broken pipe');
    write.reject(failure);

    await expect(pending).resolves.toMatchObject({ status: 'failed' });
    expect(writer.lastError).toBe(failure);
  });

  it('closes stdin once during a close/write race and rejects the pending write', async () => {
    const write = deferred<number>();
    const stdin = {
      write: vi.fn(() => write.promise),
      end: vi.fn(() => Promise.resolve(0)),
    };
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });
    writer.markReady();

    const pending = writer.writeUserMessage('work');
    writer.close();
    writer.close();
    write.resolve(1);

    await expect(pending).resolves.toMatchObject({ status: 'failed' });
    expect(stdin.end).toHaveBeenCalledTimes(1);
  });

  it('does not let late readiness resurrect closed input', () => {
    const stdin = createMockFileSink();
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });
    void writer.ready.catch(() => undefined);

    writer.close();
    writer.markReady();

    expect(writer.isReady).toBe(false);
    expect(writer.isClosed).toBe(true);
    expect(writer.writeUserMessage('late')).toMatchObject({ status: 'failed' });

    writer.markProviderExited();
    expect(writer.isClosed).toBe(true);
  });
});
