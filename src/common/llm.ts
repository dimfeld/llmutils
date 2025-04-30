import type { StreamTextResult, ToolSet } from 'ai';
import { writeStderr, writeStdout } from '../logging.ts';

/** Use `bat` to format Markdown text as it streams through. We use bat instead of a JS-native solution
 * since it works better for streaming markdown. */
class MarkdownBuffer {
  push: (text: string) => void;

  batProcess: Bun.PipedSubprocess;

  constructor(callback: (text: string) => void, language = 'md') {
    this.push = callback;
    this.batProcess = Bun.spawn(['bat', `--language=${language}`, '-pp'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  async handleStream(stdout: ReadableStream<Uint8Array>) {
    for await (const chunk of stdout) {
      let str = chunk.toString();
      this.push(str);
    }
  }

  add(chunk: string) {
    this.batProcess.stdin.write(chunk);
  }

  async flush() {
    await this.batProcess.stdin.flush();
  }

  async done() {
    await this.batProcess.stdin.end();
    await this.batProcess.exited;
  }
}

class PassthroughBuffer {
  push: (text: string) => void;
  constructor(callback: (text: string) => void) {
    this.push = callback;
  }
  add(chunk: string) {
    this.push(chunk);
  }

  async flush() {}
  async done() {}
}

export interface HandleStreamTextResultOptions {
  format?: boolean;
  showReasoning?: boolean;
}

/** Stream the text result to the console */
export async function handleStreamTextResult<T extends ToolSet, U>(
  result: StreamTextResult<T, U>,
  { format = false, showReasoning = false }: HandleStreamTextResultOptions = {}
): Promise<StreamTextResult<T, U>> {
  let reasoningRenderer: MarkdownBuffer | PassthroughBuffer | undefined =
    format && showReasoning ? new MarkdownBuffer(writeStderr) : new PassthroughBuffer(writeStderr);
  let textRenderer = format ? new MarkdownBuffer(writeStdout) : new PassthroughBuffer(writeStdout);

  try {
    for await (const chunk of result.fullStream) {
      if (chunk.type === 'reasoning') {
        reasoningRenderer?.add(chunk.textDelta);
      } else if (chunk.type === 'text-delta') {
        if (reasoningRenderer) {
          await reasoningRenderer.done();
          reasoningRenderer = undefined;
        }
        textRenderer.add(chunk.textDelta);
      }
    }
    textRenderer.add('\n');
  } finally {
    await reasoningRenderer?.done();
    await textRenderer.done();
  }

  return result;
}
