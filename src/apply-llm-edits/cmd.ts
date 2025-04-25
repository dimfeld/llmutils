#!/usr/bin/env bun

/* Apply LLM whole-file blocks from copied LLM output.
 * This looks for blocks with filenames either in a comment at the start of the block
 * or on the last non-blank line before the block (as a markdown header or raw filename),
 * and writes the contents to the path given, relative to the Git root.
 **/

import { applyLlmEdits, getWriteRoot } from './apply.js';
import clipboard from 'clipboardy';
import { setDebug } from '../rmfilter/utils.ts';

const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log('Usage: apply-llm-edits [options]');
  console.log('Options:');
  console.log('  --stdin           Read input from stdin');
  console.log('  --cwd <path>      Write files based on the given path');
  console.log('  --udiff           Force udiff mode');
  console.log('  --debug           Enable debug logging');
  console.log('  --dry-run         Dry run - do not apply changes');
  process.exit(0);
}

const useStdin = args.includes('--stdin') || !process.stdin.isTTY;
const dryRun = args.includes('--dry-run');
const cwdIndex = args.findIndex((arg) => arg == '--cwd');
const cwd = cwdIndex != -1 ? args[cwdIndex + 1] : undefined;

setDebug(args.includes('--debug'));

const content = useStdin ? await Bun.stdin.text() : await clipboard.read();

applyLlmEdits({
  content,
  writeRoot: await getWriteRoot(cwd),
  dryRun,
  mode: args.includes('--udiff') ? 'udiff' : undefined,
}).catch((err) => {
  console.error('Error processing input:', err);
  process.exit(1);
});
