import type { StreamingProcess } from '../../../common/process.ts';
import type { SpawnAndLogOutputResult } from '../../../common/process.ts';
import type { FileSink } from 'bun';

export function buildSingleUserInputMessageLine(content: string): string {
  const inputMessage = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  });
  return `${inputMessage}\n`;
}

export async function sendSinglePromptAndWait(
  streamingProcess: StreamingProcess,
  content: string
): Promise<SpawnAndLogOutputResult> {
  streamingProcess.stdin.write(buildSingleUserInputMessageLine(content));
  await streamingProcess.stdin.end();
  return streamingProcess.result;
}

export function sendInitialPrompt(streamingProcess: StreamingProcess, content: string): void {
  streamingProcess.stdin.write(buildSingleUserInputMessageLine(content));
}

export function sendFollowUpMessage(stdin: FileSink, content: string): void {
  stdin.write(buildSingleUserInputMessageLine(content));
}

export function safeEndStdin(stdin: FileSink, debugLog: (...args: unknown[]) => void): void {
  try {
    const endResult = stdin.end();
    Promise.resolve(endResult).catch((err) => {
      debugLog('Failed to close stdin: %s', err as Error);
    });
  } catch (err) {
    debugLog('Failed to close stdin: %s', err as Error);
  }
}

export async function closeStdinAndWait(
  streamingProcess: StreamingProcess
): Promise<SpawnAndLogOutputResult> {
  try {
    const endResult = streamingProcess.stdin.end();
    await Promise.resolve(endResult);
  } catch {
    // stdin already closed or broken pipe - safe to ignore during cleanup
  }
  return streamingProcess.result;
}
