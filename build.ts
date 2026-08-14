#!/usr/bin/env bun
import type { BuildConfig } from 'bun';

const gitSha = (await Bun.$`git rev-parse --short HEAD`.text()).trim();
const buildTime = new Date().toISOString();

async function buildOne(options: BuildConfig) {
  try {
    return await Bun.build({
      ...options,
      sourcemap: 'linked',
      external: ['effect', '@valibot/to-json-schema', 'sury'],
      define: {
        __TIM_BUILD_SHA__: JSON.stringify(gitSha),
        __TIM_BUILD_TIME__: JSON.stringify(buildTime),
      },
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
    entrypoints: ['./src/tim/executors/claude_code/tim_mcp.ts'],
    target: 'bun',
    minify: true,
  }),
]);

console.log(output.map((o) => o?.outputs.flatMap((o) => o.path)).join('\n'));

if (output.some((o) => !o)) {
  process.exit(1);
}
