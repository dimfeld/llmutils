#!/usr/bin/env bun
import clipboard from 'clipboardy';
import { parseArgs } from 'util';
import { applyLlmEdits } from './apply-llm-edits/apply.ts';
import { log } from './logging.ts';

const DEFAULT_RUN_MODEL = 'gemini-2.5-pro-exp-03-25';
const { values, positionals } = parseArgs({
  arg: Bun.argv,
  options: {
    model: { type: 'string', short: 'm', default: DEFAULT_RUN_MODEL },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
  allowPositionals: true,
});

if (values.help) {
  log(`Usage: rmrun [options] [filename]
Options:
  -m, --model     Model to use (default: ${DEFAULT_RUN_MODEL})
  -h, --help      Print this help message
`);
  process.exit(0);
}

let input: string;
let filename = positionals[0] || 'repomix-output.xml';
if (await Bun.file(filename).exists()) {
  log(`Reading from ${filename}`);
  input = await Bun.file(filename).text();
} else {
  log('Reading from clipboard');
  input = await clipboard.read();
  process.exit(1);
}

const llm = Bun.spawn({
  cmd: ['llm', '-m', values.model, '-o', 'temperature', '0'],
  stdin: new TextEncoder().encode(input),
  stdout: 'pipe',
});

const consoleWriter = Bun.spawn(['bat', '--language=md', '-pp'], {
  stdin: 'pipe',
  stdout: 'inherit',
});

const outputFile = Bun.file('repomix-result.txt').writer();

let decoder = new TextDecoder();
const chunks: string[] = [];
for await (const chunk of llm.stdout) {
  outputFile.write(chunk);
  consoleWriter.stdin.write(chunk);
  chunks.push(decoder.decode(chunk, { stream: true }));
}

await consoleWriter.stdin.end();
await outputFile.end();

log('\nWrote to repomix-result.txt. Applying...');

const content = chunks.join('');
log('Applying changes...');
await applyLlmEdits({ content });
