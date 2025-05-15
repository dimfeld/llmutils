#!/usr/bin/env bun

/* Apply LLM whole-file blocks from copied LLM output.
 * This looks for blocks with filenames either in a comment at the start of the block
 * or on the last non-blank line before the block (as a markdown header or raw filename),
 * and writes the contents to the path given, relative to the Git root.
 **/

import clipboard from 'clipboardy';
import * as path from 'node:path';
import { parseArgs } from 'util';
import { error, log } from '../logging.ts';
import { setDebug } from '../rmfilter/utils.ts';
import { applyLlmEdits, getWriteRoot } from './apply.js';
import { createRetryRequester, type RetryRequester } from './retry.ts';
import { DEFAULT_RUN_MODEL } from '../common/run_and_apply.ts';

const { values } = parseArgs({
  options: {
    stdin: { type: 'boolean' },
    clipboard: { type: 'boolean' },
    file: { type: 'string', short: 'f' },
    cwd: { type: 'string' },
    mode: { type: 'string' },
    interactive: { type: 'boolean', short: 'i' },
    retry: { type: 'boolean' },
    model: { type: 'string', short: 'm' },
    'partial-apply': { type: 'boolean' },
    pa: { type: 'boolean' },
    'copy-retry-prompt': { type: 'boolean' },
    cr: { type: 'boolean' },
    'original-prompt': { type: 'string' },
    op: { type: 'string' },
    debug: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  log(
    `Usage: apply-llm-edits [options]
Options:
  --stdin                        Read from stdin (the default if input is piped in)
  --clipboard                    Read from the clipboard even if stdin is available
  -f <file>, --file <file>       Read from a file
  --cwd <path>                   Write files based on the given path
  --mode <mode>                  Force an edit mode
  -i, --interactive              Enable interactive mode for resolving edit failures
  --retry                        Do an automatic retry via LLM on failure (CLI support limited)
  -m, --model <model>            AI model to use for prompt fixing (default: ${DEFAULT_RUN_MODEL})
  --pa, --partial-apply          Apply successes even if there are failures
  --cr, --copy-retry-prompt      Copy a retry prompt to clipboard on failure
  --op, --original-prompt <file> Path to the original prompt file for retry context
  --debug                        Enable debug logging
  --dry-run                      Dry run - do not apply changes`
  );
  process.exit(0);
}

const useClipboard = values.clipboard || false;
const useStdin = !useClipboard && (values.stdin || !process.stdin.isTTY);
const file = values.file;
const dryRun = values['dry-run'] || false;
const interactive = values.interactive || false;
const applyPartial = values['partial-apply'] || values.pa || false;
const retry = values.retry || false;
const copyRetryPrompt = values['copy-retry-prompt'] || values.cr || false;
const cwd = values.cwd;
const modeValue = values.mode;
const originalPromptPath = values['original-prompt'] || values.op;
const modelValue = values.model;

setDebug(values.debug || false);

let content: string | undefined;
if (file) {
  content = await Bun.file(file).text();
} else {
  let content = useStdin ? await Bun.stdin.text() : await clipboard.read();
  if (!content) {
    content = await clipboard.read();
  }
}

if (!content) {
  error('No input provided');
  process.exit(1);
}

// Determine the base directory for operations. Uses --cwd if provided, otherwise git root or current dir.
const baseDir = await getWriteRoot(cwd);

// Read original prompt content if path is provided
let originalPromptContent: string | undefined = undefined;
if (originalPromptPath) {
  try {
    const absolutePromptPath = path.resolve(process.cwd(), originalPromptPath);
    originalPromptContent = await Bun.file(absolutePromptPath).text();
    log(`Read original prompt from: ${absolutePromptPath}`);
  } catch (err: any) {
    error(`Error reading original prompt file "${originalPromptPath}":`, err.message);
    process.exit(1);
  }
}

let retryRequester: RetryRequester | undefined;
if (retry) {
  retryRequester = createRetryRequester(modelValue || DEFAULT_RUN_MODEL);
}

applyLlmEdits({
  content,
  writeRoot: baseDir,
  baseDir: baseDir,
  dryRun,
  mode: modeValue as 'diff' | 'udiff' | 'xml' | 'whole',
  interactive,
  applyPartial,
  originalPrompt: originalPromptContent,
  copyRetryPrompt,
  retryRequester,
}).catch((err) => {
  error('Error processing input:', err);
  process.exit(1);
});
