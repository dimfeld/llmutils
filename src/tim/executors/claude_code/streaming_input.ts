import type { StreamingProcess } from '../../../common/process.ts';
import type { SpawnAndLogOutputResult } from '../../../common/process.ts';

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
