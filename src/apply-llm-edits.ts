#!/usr/bin/env bun

/* Apply LLM whole-file blocks from copied LLM output.
 * This looks for blocks with filenames either in a comment at the start of the block
 * or on the last non-blank line before the block (as a markdown header or raw filename),
 * and writes the contents to the path given, relative to the Git root.
 **/

import { $ } from 'bun';
import clipboard from 'clipboardy';
import { enableDebug } from './logging.ts';
import { processRawFiles } from './parse_raw_edits.ts';
import { processXmlContents } from './parse_xml.ts';
import { processSearchReplace } from './diff-editor/parse.ts';

const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log('Usage: apply-llm-edits [options]');
  console.log('Options:');
  console.log('  --stdin           Read input from stdin');
  console.log('  --gitroot         Write files to the Git root');
  console.log('  --debug           Enable debug logging');
  console.log('  --dry-run         Dry run - do not apply changes');
  process.exit(0);
}

const useStdin = args.includes('--stdin');
const writeToGitroot = args.includes('--gitroot');
const dryRun = args.includes('--dry-run');

enableDebug(args.includes('--debug'));

const content = useStdin ? await Bun.stdin.text() : await clipboard.read();

const writeRoot = writeToGitroot
  ? (await $`git rev-parse --show-toplevel`.text()).trim()
  : process.cwd();

const xmlMode = content.includes('<code_changes>');
const diffMode = content.includes('<<<<<<< SEARCH');

export interface ProcessFileOptions {
  content: string;
  writeRoot: string;
  dryRun: boolean;
}

let processPromise;
if (xmlMode) {
  processPromise = processXmlContents({
    content,
    writeRoot,
    dryRun,
  });
} else if (diffMode) {
  processPromise = processSearchReplace({
    content,
    writeRoot,
    dryRun,
  });
} else {
  processPromise = processRawFiles({
    content,
    writeRoot,
    dryRun,
  });
}

processPromise.catch((err) => {
  console.error('Error processing input:', err);
  process.exit(1);
});
