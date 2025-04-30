#!/usr/bin/env bun
import clipboard from 'clipboardy';
import { parseArgs } from 'util';
import { applyLlmEdits } from './apply-llm-edits/apply.ts';
import { log } from './logging.ts';
import { streamText } from 'ai';
import { createModel } from './common/model_factory.ts';
import { streamResultToConsole } from './common/llm.ts';

const DEFAULT_RUN_MODEL = 'google/gemini-2.5-pro-exp-03-25';
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
if (!process.stdin.isTTY) {
  log('Reading from stdin');
  input = await Bun.stdin.text();
} else if (await Bun.file(filename).exists()) {
  log(`Reading from ${filename}`);
  input = await Bun.file(filename).text();
} else {
  log('Reading from clipboard');
  input = await clipboard.read();
  process.exit(1);
}

const outputFile = Bun.file('repomix-result.txt');
// Bun won't truncate the existing content when using a file writer
await outputFile.unlink();
const fileWriter = outputFile.writer();

const result = streamText({
  model: createModel(values.model),
  temperature: 0,
  prompt: input,
});

await streamResultToConsole(result, {
  format: true,
  showReasoning: true,
  cb: (text: string) => {
    fileWriter.write(new TextEncoder().encode(text));
  },
});

await fileWriter.end();
log('\nWrote to repomix-result.txt. Applying...');

const content = await result.text;
await applyLlmEdits({ content });
