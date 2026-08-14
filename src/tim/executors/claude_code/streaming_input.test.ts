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
  it('accepts a synchronous active-turn write and uses canonical JSONL encoding', () => {
    const stdin = createMockFileSink();
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });
    writer.markReady('active');

    expect(writer.writeUserMessage('quoted "content" and \\ slash')).toEqual({
      status: 'accepted',
      acknowledgement: 'steered',
      generation: 1,
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
    writer.markReady('active');

    const first = writer.writeUserMessage('first');
    expect(first).toBeInstanceOf(Promise);
    expect(writer.writeUserMessage('second')).toEqual({
      status: 'temporarily-unavailable',
      reason: 'write-in-progress',
    });

    write.resolve(1);
    await expect(first).resolves.toEqual({
      status: 'accepted',
      acknowledgement: 'steered',
      generation: 1,
    });
    expect(stdin.writes).toHaveLength(1);
    expect(availability).toHaveBeenCalled();
    expect(writer.isWriteInProgress).toBe(false);
  });

  it('claims idle synchronously so concurrent sends cannot start two turns', async () => {
    const write = deferred<number>();
    const stdin = {
      write: vi.fn(() => write.promise),
      end: vi.fn(() => Promise.resolve(0)),
    };
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });
    writer.markReady('idle');

    const first = writer.writeUserMessage('first');
    expect(writer.state).toBe('active');
    const second = writer.writeUserMessage('second');
    expect(second).toEqual({
      status: 'temporarily-unavailable',
      reason: 'write-in-progress',
    });
    expect(stdin.write).toHaveBeenCalledTimes(1);

    write.resolve(1);
    await expect(first).resolves.toMatchObject({
      status: 'accepted',
      acknowledgement: 'started-idle-turn',
    });
  });

  it('restores idle only for the generation that claimed it', async () => {
    const firstWrite = deferred<number>();
    const stdin = {
      write: vi.fn(() => firstWrite.promise),
      end: vi.fn(() => Promise.resolve(0)),
    };
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });
    writer.markReady('idle');

    const first = writer.writeUserMessage('first');
    writer.markProviderState('active');
    firstWrite.reject(new Error('write failed'));

    await expect(first).resolves.toMatchObject({ status: 'closed-or-failed' });
    expect(writer.state).toBe('active');
    expect(writer.generation).toBe(2);
  });

  it('restores idle after an un-superseded rejected write and reports the failure', async () => {
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
    writer.markReady('idle');

    const pending = writer.writeUserMessage('first');
    write.reject(new Error('broken pipe'));

    await expect(pending).resolves.toMatchObject({ status: 'closed-or-failed' });
    expect(writer.state).toBe('idle');
    expect(failure).toHaveBeenCalledOnce();
  });

  it('returns closed-or-failed for thrown writes and closed input without queueing', () => {
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
    writer.markReady('active');

    expect(writer.writeUserMessage('first')).toMatchObject({ status: 'closed-or-failed' });
    writer.close();
    expect(writer.writeUserMessage('second')).toMatchObject({ status: 'closed-or-failed' });
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
    writer.markReady('active');
    expect(writer.writeUserMessage('initial')).toMatchObject({ status: 'accepted' });
  });

  it('maps accepted and closed writes through AgentInputAdapter delivery', async () => {
    const stdin = createMockFileSink();
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });
    writer.markReady('idle');

    await expect(
      Promise.resolve(
        writer.deliver({ messageId: 'message-1', source: {} as never, content: 'continue' })
      )
    ).resolves.toBe('started-idle-turn');

    writer.close();
    await expect(
      Promise.resolve().then(() =>
        writer.deliver({ messageId: 'message-2', source: {} as never, content: 'late' })
      )
    ).rejects.toThrow('closed or failed');
  });

  it('closes stdin once during a close/write race and rejects the pending delivery', async () => {
    const write = deferred<number>();
    const stdin = {
      write: vi.fn(() => write.promise),
      end: vi.fn(() => Promise.resolve(0)),
    };
    const writer = new PersistentClaudeInputWriter({
      stdin: stdin as unknown as FileSink,
      debugLog: vi.fn(),
    });
    writer.markReady('active');

    const pending = writer.deliver({
      messageId: 'message-1',
      source: {} as never,
      content: 'work',
    });
    writer.close();
    writer.close();
    write.resolve(1);

    await expect(pending).rejects.toThrow('closed or failed');
    expect(stdin.end).toHaveBeenCalledTimes(1);
  });
});
