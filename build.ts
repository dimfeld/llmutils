#!/usr/bin/env bun
import type { BuildConfig } from 'bun';
import { glob } from 'glob';
import { promises as fs } from 'fs';
import path from 'path';

async function buildOne(options: BuildConfig) {
  try {
    return await Bun.build({
      ...options,
      external: ['effect', '@valibot/to-json-schema', 'sury'],
    });
  } catch (e) {
    console.error(`Building ${options.entrypoints.join(', ')} failed`);
    console.error(e);
    return null;
  }
}

async function copyWasmFiles() {
  const wasmFiles = await glob('node_modules/**/*.wasm');

  await fs.mkdir('dist', { recursive: true });

  for (const wasmFile of wasmFiles) {
    if (wasmFile.includes('/web-tree-sitter/debug') || wasmFile.includes('/web-tree-sitter/lib')) {
      continue;
    }

    const fileName = path.basename(wasmFile);
    const destPath = path.join('dist', fileName);

    await fs.copyFile(wasmFile, destPath);
  }

  console.log(`Copied ${wasmFiles.length} .wasm files to dist`);
}

const output = await Promise.all([
  buildOne({
    outdir: 'dist',
    entrypoints: ['./src/rmplan/rmplan.ts'],
    target: 'bun',
    minify: true,
    // bytecode: true,
  }),
  buildOne({
    outdir: 'dist/claude_code',
    entrypoints: ['./src/rmplan/executors/claude_code/permissions_mcp.ts'],
    target: 'bun',
    minify: true,
    // bytecode: true,
  }),
]);

console.log(output.map((o) => o?.outputs.flatMap((o) => o.path)).join('\n'));

if (output.some((o) => !o)) {
  process.exit(1);
}

// Copy .wasm files after successful build
await copyWasmFiles();
