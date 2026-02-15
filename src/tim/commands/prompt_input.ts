export type PromptResolverDeps = {
  readFile?: (filePath: string) => Promise<string>;
  readStdin?: () => Promise<string>;
};

export interface ResolveOptionalPromptInputOptions {
  promptText?: string;
  promptFile?: string;
  stdinIsTTY?: boolean;
  readStdinWhenNotTTY?: boolean;
  preferPositionalPrompt?: boolean;
}

export async function resolveOptionalPromptInput(
  options: ResolveOptionalPromptInputOptions,
  deps: PromptResolverDeps = {}
): Promise<string | undefined> {
  const baseReadFile = deps.readFile ?? ((filePath: string) => Bun.file(filePath).text());
  const readStdin = deps.readStdin ?? (() => Bun.stdin.text());
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY;
  const positionalPrompt = normalizePrompt(options.promptText);

  if (options.promptFile) {
    try {
      return normalizePrompt(await baseReadFile(options.promptFile));
    } catch (err) {
      throw new Error(`Failed to read prompt file "${options.promptFile}": ${err as Error}`);
    }
  }

  if (options.preferPositionalPrompt === true && positionalPrompt) {
    return positionalPrompt;
  }

  if (options.readStdinWhenNotTTY === true && !stdinIsTTY) {
    return normalizePrompt(await readStdin());
  }

  return positionalPrompt;
}

function normalizePrompt(prompt: string | undefined): string | undefined {
  if (!prompt || prompt.trim().length === 0) {
    return undefined;
  }

  return prompt;
}
