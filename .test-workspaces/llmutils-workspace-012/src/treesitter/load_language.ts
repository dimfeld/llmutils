import { createRequire } from 'node:module';
import path from 'node:path';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

export async function loadLanguage(langName: string): Promise<Language> {
  if (!langName) {
    throw new Error('Invalid language name');
  }

  try {
    const wasmPath = await getWasmPath(langName);
    return await Language.load(wasmPath);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load language ${langName}: ${message}`);
  }
}

async function getWasmPath(langName: string): Promise<string> {
  let path: string;
  if (langName === 'typescript') {
    path = require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm');
  } else if (langName === 'svelte') {
    path = require.resolve('tree-sitter-svelte/tree-sitter-svelte.wasm');
  } else {
    throw new Error(`Unsupported language: ${langName}`);
  }

  return path;
}
