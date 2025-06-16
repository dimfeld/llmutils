#!/usr/bin/env bun
import type { BuildConfig } from 'bun';

async function buildOne(options: BuildConfig) {
  try {
    return await Bun.build({
      ...options,
      external: ['effect', '@valibot/to-json-schema', 'sury'],
    });
  } catch (e) {
    console.error(`Building ${options.entrypoints} failed`);
    console.error(e);
    return null;
  }
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
