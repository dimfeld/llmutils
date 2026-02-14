import { describe, expect, it } from 'bun:test';
import type { FileSink } from 'bun';
import type { SpawnAndLogOutputResult, StreamingProcess } from '../../../common/process.ts';
import {
  buildSingleUserInputMessageLine,
  closeStdinAndWait,
  safeEndStdin,
  sendFollowUpMessage,
  sendInitialPrompt,
} from './streaming_input.ts';

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

  it('closeStdinAndWait closes stdin and returns the subprocess result', async () => {
    const stdin = createMockFileSink();
    const result: SpawnAndLogOutputResult = {
      exitCode: 17,
      stdout: 'output',
      stderr: 'error output',
      signal: null,
      killedByInactivity: false,
    };
    const process = createStreamingProcessMock(stdin, result);

    const resolved = await closeStdinAndWait(process);

    expect(stdin.endCalls).toBe(1);
    expect(resolved).toEqual(result);
  });

  it('supports multiple messages before close', async () => {
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
    const resolved = await closeStdinAndWait(process);

    expect(stdin.writes).toEqual([
      buildSingleUserInputMessageLine('Initial prompt'),
      buildSingleUserInputMessageLine('Follow-up 1'),
      buildSingleUserInputMessageLine('Follow-up 2'),
    ]);
    expect(stdin.endCalls).toBe(1);
    expect(resolved).toEqual(result);
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
