#!/usr/bin/env bun
import { $ } from 'bun';
import clipboard from 'clipboardy';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { debugLog } from '../logging.ts';
import { getGitRoot, setDebug, setQuiet } from '../rmfilter/utils.ts';
import { findFilesCore, type RmfindOptions, type RmfindResult } from './core.ts';

const DEFAULT_MODEL = 'google/gemini-2.0-flash';

const { values, positionals } = parseArgs({
  options: {
    grep: { type: 'string', short: 'g', multiple: true },
    ignore: { type: 'string', multiple: true },
    'whole-word': { type: 'boolean', short: 'w' },
    expand: { type: 'boolean', short: 'e' },
    cwd: { type: 'string' },
    gitroot: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    debug: { type: 'boolean' },
    quiet: { type: 'boolean' },
    model: { type: 'string', short: 'm', default: DEFAULT_MODEL },
    fzf: { type: 'boolean' },
    yaml: { type: 'boolean' },
    query: { type: 'string', short: 'q' },

    // Debugging options

    // Allow overriding specific models
    'classifier-model': { type: 'string' },
    'grep-generator-model': { type: 'string' },

    // One of: grep-generation, grep, classify
    'stop-after': { type: 'string' },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`Usage: rmfind [options] [globs/dirs...]

Find files using globs and/or ripgrep, then select them using fzf.

Options:
  -g, --grep <pattern>   Filter files by ripgrep pattern (can be repeated).
  --ignore <pattern>     Glob pattern for files/dirs to ignore (can be repeated).
  -w, --whole-word       Match whole words in grep.
  -e, --expand           Expand grep patterns (snake_case, camelCase).
  -q, --query <query>    Filter files using a natural language query (requires AI SDK).
  -m, --model <model>    AI model to use (default: ${DEFAULT_MODEL}).
  --cwd <dir>            Set working directory.
  --gitroot              Use Git root as working directory.
  -h, --help             Show this help message.
  --debug                Print debug information.
  --quiet                Suppress informational output
  --yaml                 Output a YAML array instead of space-separated
  --fzf                  Use fzf to select files interactively

  If no grep patterns are provided, but a query is provided, rmfind will generate grep terms from the query usng a language model.
`);
  process.exit(0);
}

setDebug(values.debug || false);
setQuiet(values.quiet || false);

async function main() {
  let baseDir: string;
  if (values.cwd) {
    baseDir = path.resolve(values.cwd);
  } else if (values.gitroot) {
    baseDir = (await getGitRoot()) || process.cwd();
  } else {
    baseDir = process.cwd();
  }
  debugLog(`Using base directory: ${baseDir}`);

  // Prepare options for findFilesCore
  const options: RmfindOptions = {
    baseDir,
    globs: positionals,
    ignoreGlobs: values.ignore,
    grepPatterns: values.grep,
    query: values.query,
    wholeWord: values['whole-word'],
    expand: values.expand,
    classifierModel: values['classifier-model'] || values.model || DEFAULT_MODEL,
    grepGeneratorModel: values['grep-generator-model'] || values.model || DEFAULT_MODEL,
    quiet: values.quiet ?? false,
  };

  if (options.globs.length === 0 && !options.grepPatterns && !options.query) {
    if (!process.stdin.isTTY) {
      const stdin = await Bun.stdin.text();
      if (stdin) {
        options.query = stdin;
      }
    }

    if (!options.query) {
      console.error('Error: No globs, directories, grep patterns, or query provided.');
      console.error('Use --help for usage information.');
      process.exit(1);
    }
  }

  // Call the core finding logic
  const result: RmfindResult = await findFilesCore(options);
  const foundFiles = result.files; // These are absolute paths

  if (foundFiles.length === 0) {
    if (!values.quiet) {
      console.log('No files found matching the criteria.');
    }
    process.exit(0);
  }

  // 4. Process files (with fzf if --fzf is set, otherwise use all filtered files)
  let selectedRelativeFiles: string[] = [];
  if (values.fzf) {
    try {
      // Check fzf availability *only* if --fzf is used
      await $`which fzf`.quiet();
    } catch (error) {
      console.error('Error: fzf command not found. Please install fzf.');
      process.exit(1);
    }

    const fzfInput = foundFiles.map((file) => path.relative(baseDir, file)).join('\n');
    const fzfProc = Bun.spawn(
      [
        'fzf',
        '--multi',
        '--ansi',
        '--tac',
        '--preview',
        'bat --color=always --style=numbers {} || cat {}',
        '--preview-window',
        'right:50%',
      ],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'inherit', // Show fzf UI errors
        cwd: baseDir,
      }
    );

    fzfProc.stdin.write(fzfInput);
    await fzfProc.stdin.end();

    const fzfOutput = await new Response(fzfProc.stdout).text();
    const exitCode = await fzfProc.exited;

    if (exitCode !== 0) {
      // fzf exits with 130 if user cancels (e.g., Esc or Ctrl+C)
      if (exitCode !== 130 && !values.quiet) {
        console.error(`fzf exited with error code ${exitCode}`);
      }
      // Exit silently if user cancelled or error occurred
      process.exit(exitCode === 130 ? 0 : 1);
    } else {
      selectedRelativeFiles = fzfOutput.trim().split('\n').filter(Boolean);
    }
  } else {
    selectedRelativeFiles = foundFiles.map((file) => path.relative(baseDir, file));
  }

  // 5. Output Selection
  if (selectedRelativeFiles.length === 0) {
    if (!values.quiet) {
      console.warn('No files selected.');
    }
    process.exit(0);
  }

  if (selectedRelativeFiles.length > 0) {
    let output: string;
    if (values.yaml) {
      output = selectedRelativeFiles.map((file) => `    - "${file}"`).join('\n');
    } else {
      output = selectedRelativeFiles.map((file) => `'${file}'`).join(' ');
    }

    await clipboard.write(output);
    console.log(output);
  }
}

main().catch((err) => {
  console.error('An unexpected error occurred:', err);
  process.exit(1);
});
