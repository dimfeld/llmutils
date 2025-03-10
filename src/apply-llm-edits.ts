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

const args = process.argv.slice(2);
const useStdin = args.includes('--stdin');
const writeToGitroot = args.includes('--gitroot');
const xmlMode = args.includes('--xml');

enableDebug(args.includes('--debug'));

const content = useStdin ? await Bun.stdin.text() : await clipboard.read();

const writeRoot = writeToGitroot
  ? (await $`git rev-parse --show-toplevel`.text()).trim()
  : process.cwd();

if (xmlMode) {
  processXmlContents({
    content,
    writeRoot,
  }).catch((err: Error) => {
    console.error('Error processing input:', err);
    process.exit(1);
  });
} else {
  processRawFiles({
    content,
    writeRoot,
  }).catch((err) => {
    console.error('Error processing input:', err);
    process.exit(1);
  });
}
