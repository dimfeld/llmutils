#!/usr/bin/env bun
import type { BuildConfig } from 'bun';

async function buildOne(options: BuildConfig) {
  try {
    return await Bun.build({
      ...options,
      sourcemap: 'linked',
      external: ['effect', '@valibot/to-json-schema', 'sury'],
    });
  } catch (e) {
    console.error(`Building ${options.entrypoints.join(', ')} failed`);
    console.error(e);
    return null;
  }
}

process.env.BUN_NO_CODESIGN_MACHO_BINARY = '1';

const output = await Promise.all([
  buildOne({
    outdir: 'dist',
    entrypoints: ['./src/tim/tim.ts'],
    target: 'bun',
    minify: true,
    format: 'esm',
    compile: true,
    // bytecode: true,
  }),
  buildOne({
    outdir: 'dist/webhooks',
    entrypoints: ['./src/webhooks/server.ts'],
    target: 'bun',
    minify: true,
    format: 'esm',
    compile: true,
    // bytecode: true,
  }),
  buildOne({
    outdir: 'dist/media-host',
    entrypoints: ['./src/media-host/server.ts'],
    target: 'bun',
    minify: true,
    format: 'esm',
    compile: true,
    // bytecode: true,
  }),
  buildOne({
    outdir: 'dist/claude_code',
    entrypoints: ['./src/tim/executors/claude_code/permissions_mcp.ts'],
    target: 'bun',
    minify: true,
  }),
]);

console.log(output.map((o) => o?.outputs.flatMap((o) => o.path)).join('\n'));

if (output.some((o) => !o)) {
  process.exit(1);
}
