#!/usr/bin/env bun
import clipboard from 'clipboardy';
import { parseArgs } from 'util';
import { applyLlmEdits } from './apply-llm-edits/apply.ts';
import { createRetryRequester } from './apply-llm-edits/retry.ts';
import { loadEnv } from './common/env.ts';
import { askForModelId } from './common/model_factory.ts';
import { DEFAULT_RUN_MODEL, runStreamingPrompt } from './common/run_and_apply.ts';
import { log } from './logging.ts';
import { setDebug } from './rmfilter/utils.ts';

await loadEnv();

const { values, positionals } = parseArgs({
  arg: Bun.argv,
  options: {
    model: { type: 'string', short: 'm' },
    help: { type: 'boolean', short: 'h' },
    debug: { type: 'boolean' },
  },
  strict: true,
  allowPositionals: true,
});

if (values.debug) {
  setDebug(true);
}

if (values.help) {
  log(`Usage: rmrun [options] [filename]
Options:
  -m, --model     Model to use (default: ${DEFAULT_RUN_MODEL})
  -h, --help      Print this help message
`);
  process.exit(0);
}

if (!values.model) {
  values.model =
    (
      await askForModelId({
        onlyDirectCall: true,
      })
    )?.value ?? DEFAULT_RUN_MODEL;
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

const result = await runStreamingPrompt({
  input,
  model: values.model,

  handleTextChunk: (text: string) => {
    fileWriter.write(new TextEncoder().encode(text));
  },
});

await fileWriter.end();
log('\nWrote to repomix-result.txt. Applying...');

const content = result.text;
await applyLlmEdits({
  content,
  originalPrompt: input,
  retryRequester: createRetryRequester(values.model),
  interactive: true,
});
