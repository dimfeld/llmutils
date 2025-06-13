#!/usr/bin/env bun
const output = await Bun.build({
  outdir: 'dist',
  entrypoints: ['./src/rmplan/rmplan.ts'],
  target: 'bun',
  minify: true,
  // bytecode: true,
});

console.log(output.outputs);
