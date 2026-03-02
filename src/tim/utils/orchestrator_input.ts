import { readFile } from 'node:fs/promises';

export interface OrchestratorInputOptions {
  input?: string;
  inputFile?: string;
}

interface ResolveOrchestratorInputOptions extends OrchestratorInputOptions {
  fallbackToStdin?: boolean;
}

export async function resolveOrchestratorInput(
  options: ResolveOrchestratorInputOptions
): Promise<string | undefined> {
  if (options.input && options.inputFile) {
    throw new Error('Cannot provide both --input and --input-file. Use only one.');
  }

  if (options.input) {
    return options.input;
  }

  if (options.inputFile) {
    if (options.inputFile === '-') {
      return readStdinText(true);
    }
    return readFile(options.inputFile, 'utf8');
  }

  if (options.fallbackToStdin && !process.stdin.isTTY) {
    const stdinText = await readStdinText(false);
    if (stdinText?.trim()) {
      return stdinText;
    }
  }

  return undefined;
}

async function readStdinText(requireInput: boolean): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    if (requireInput) {
      throw new Error('--input-file - requires input on stdin.');
    }
    return undefined;
  }

  const input = await Bun.stdin.text();
  if (!input.trim()) {
    if (requireInput) {
      throw new Error('No input received on stdin.');
    }
    return undefined;
  }

  return input;
}
