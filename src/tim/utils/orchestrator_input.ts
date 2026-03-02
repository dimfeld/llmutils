import { readFile } from 'node:fs/promises';

export interface OrchestratorInputOptions {
  input?: string;
  inputFile?: string | string[];
}

interface ResolveOrchestratorInputOptions extends OrchestratorInputOptions {
  fallbackToStdin?: boolean;
}

export async function resolveOrchestratorInput(
  options: ResolveOrchestratorInputOptions
): Promise<string | undefined> {
  if (options.inputFile) {
    const inputFiles = normalizeInputFiles(options.inputFile);
    const sourceParts = await Promise.all(inputFiles.map((path) => readInputSource(path)));

    const filtered = sourceParts.filter((part): part is string => typeof part === 'string');

    if (typeof options.input === 'string' && options.input.length > 0) {
      filtered.push(options.input);
    }

    if (filtered.length > 0) {
      return filtered.join('\n\n');
    }
  } else if (typeof options.input === 'string' && options.input.length > 0) {
    return options.input;
  }

  if (options.fallbackToStdin && !process.stdin.isTTY) {
    const stdinText = await readStdinText(false);
    if (stdinText?.trim()) {
      return stdinText;
    }
  }

  return undefined;
}

function normalizeInputFiles(inputFile: string | string[]): string[] {
  return Array.isArray(inputFile) ? inputFile : [inputFile];
}

async function readInputSource(path: string): Promise<string | undefined> {
  if (path === '-') {
    return readStdinText(true);
  }
  return readFile(path, 'utf8');
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
