import type { StreamingProcess } from '../../../common/process.ts';
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

export function sendInitialPrompt(streamingProcess: StreamingProcess, content: string): void {
  void streamingProcess.stdin.write(buildSingleUserInputMessageLine(content));
}

export function sendFollowUpMessage(stdin: FileSink, content: string): void {
  void stdin.write(buildSingleUserInputMessageLine(content));
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
