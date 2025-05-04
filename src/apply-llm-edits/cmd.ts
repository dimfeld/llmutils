#!/usr/bin/env bun

/* Apply LLM whole-file blocks from copied LLM output.
 * This looks for blocks with filenames either in a comment at the start of the block
 * or on the last non-blank line before the block (as a markdown header or raw filename),
 * and writes the contents to the path given, relative to the Git root.
 **/

import { applyLlmEdits, getWriteRoot } from './apply.js';
import * as path from 'node:path';
import clipboard from 'clipboardy';
import { setDebug, getGitRoot } from '../rmfilter/utils.ts';
import { error, log } from '../logging.ts';

const args = process.argv.slice(2);

if (args.includes('--help')) {
  log('Usage: apply-llm-edits [options]');
  log('Options:');
  log('  --stdin           Read input from stdin. This happens by default input is being piped in');
  log('  --clipboard       Read input from the clipboard even if stdin is available');
  log('  --cwd <path>      Write files based on the given path');
  log('  --mode <mode>     Force an edit mode');
  log('  --debug           Enable debug logging');
  log('  --interactive     Enable interactive mode for resolving edit failures');
  log('  --retry           Enable automatic retry via LLM on failure (CLI support limited)');
  log('  --partial-apply   Apply successes even if there are failures');
  log('  --original-prompt <file> Path to the original prompt file for retry context');
  log('  --dry-run         Dry run - do not apply changes');
  process.exit(0);
}

const useClipboard = args.includes('--clipboard');
const useStdin = !useClipboard && (args.includes('--stdin') || !process.stdin.isTTY);
const dryRun = args.includes('--dry-run');
const interactive = args.includes('--interactive');
const retry = args.includes('--retry');
const cwdIndex = args.findIndex((arg) => arg == '--cwd');
const modeIndex = args.findIndex((arg) => arg == '--mode');
const originalPromptIndex = args.findIndex((arg) => arg == '--original-prompt');
const modeValue = modeIndex != -1 ? args[modeIndex + 1] : undefined;
const cwd = cwdIndex != -1 ? args[cwdIndex + 1] : undefined;
const originalPromptPath = originalPromptIndex != -1 ? args[originalPromptIndex + 1] : undefined;

setDebug(args.includes('--debug'));

let content = useStdin ? await Bun.stdin.text() : await clipboard.read();
if (!content) {
  content = await clipboard.read();
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

applyLlmEdits({
  content,
  writeRoot: baseDir,
  baseDir: baseDir,
  dryRun,
  mode: modeValue as 'diff' | 'udiff' | 'xml' | 'whole',
  interactive,
  originalPrompt: originalPromptContent,
  llmRequester: undefined,
  // The --retry flag enables the *logic* in applyLlmEdits, but without an llmRequester, it can't call the LLM.
}).catch((err) => {
  error('Error processing input:', err);
  process.exit(1);
});
