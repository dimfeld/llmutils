#!/usr/bin/env bun
import { $ } from 'bun';
import clipboard from 'clipboardy';
import path from 'node:path';
import { parseArgs } from 'util';
import { globFiles, grepFor } from '../common/file_finder.ts';
import { debugLog } from '../logging.ts';
import { quiet, setDebug, setQuiet } from '../rmfilter/utils.ts';
import { findFilesCore, RmfindOptions, RmfindResult } from './core.ts'; // Import core elements
import { generateGrepTermsFromQuery } from './generate_grep_terms.ts';
import { filterFilesWithQuery } from './llm_file_filter.ts';

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

if (values['stop-after']) {
  // The only reason to use stop-after is for debugging so always turn it on.
  values.debug = true;
}

setDebug(values.debug || false);
setQuiet(values.quiet || false);

async function main() {
  try {
    await $`which fzf`.quiet();
  } catch (error) {
    console.error('Error: fzf command not found. Please install fzf.');
    process.exit(1);
  }

  let classifierModel = values['classifier-model'] || values.model;
  let grepGeneratorModel = values['grep-generator-model'] || values.model;

  // 1. Determine Base Directory
  let baseDir = process.cwd();
  if (values.cwd) {
    baseDir = path.resolve(values.cwd);
  } else if (values.gitroot) {
    const gitRootResult = await $`git rev-parse --show-toplevel`.nothrow().text();
    baseDir = gitRootResult.trim() || process.cwd();
  }
  debugLog(`Using base directory: ${baseDir}`);

  // 2. Find Initial Files (Globbing or Grepping)
  let initialFiles: string[] = [];
  const hasGlobs = positionals.length > 0;
  let grep = values.grep ?? [];
  let hasGrep = grep.length > 0;
  const hasQuery = !!values.query;

  if (!hasGlobs && !hasGrep && !hasQuery) {
    console.error('Error: No globs, directories, grep patterns, or query provided.');
    console.error('Use --help for usage information.');
    process.exit(1);
  }

  try {
    // Generate grep terms from query if no grep terms are provided
    if (values.query && !hasGrep) {
      grep = await generateGrepTermsFromQuery(grepGeneratorModel, values.query);
      hasGrep = grep.length > 0;

      if (!quiet) {
        console.warn(`Generated grep terms: ${grep.join(', ')}\n`);
      }
    }

    if (values['stop-after'] === 'grep-generation') {
      process.exit(0);
    }

    if (hasGlobs) {
      debugLog(
        `Globbing patterns: ${positionals.join(', ')} with ignore: ${values.ignore?.join(', ')}`
      );
      initialFiles = await globFiles(baseDir, positionals, values.ignore);
      debugLog(`Found ${initialFiles.length} files via globbing.`);
      // If grep is specified or generated, filter the globbed files
      if (hasGrep || hasQuery) {
        debugLog(
          `Grepping within ${initialFiles.length} globbed files for patterns: ${grep.join(', ')}`
        );
        initialFiles = await grepFor(
          baseDir,
          grep,
          initialFiles, // Pass globbed files as source
          values.expand ?? false,
          values['whole-word'] ?? false
        );
        debugLog(
          `Found ${initialFiles.length} files after grep filtering: ${initialFiles.join(', ')}.`
        );
      }
    } else if (hasGrep || hasQuery) {
      // Only grep is specified or generated, search the base directory
      debugLog(`Grepping base directory for patterns: ${grep.join(', ')}`);
      initialFiles = await grepFor(
        baseDir,
        grep,
        undefined, // Search baseDir
        values.expand ?? false,
        values['whole-word'] ?? false
      );
      debugLog(`Found ${initialFiles.length} files via grep: ${initialFiles.join(', ')}.`);
    }
  } catch (error) {
    console.error(`Error finding files: ${(error as Error).toString()}`);
    process.exit(1);
  }

  if (initialFiles.length === 0) {
    if (!values.quiet) {
      console.log('No files found matching the criteria.');
    }
    process.exit(0);
  }

  if (values['stop-after'] === 'grep') {
    process.exit(0);
  }

  // 3. Filter files with natural language query if provided
  let filteredFiles = initialFiles;
  if (values.query) {
    let foundFiles = await filterFilesWithQuery(
      classifierModel,
      values.query,
      baseDir,
      filteredFiles
    );

    // TODO Use the other relevance info from the classifier
    filteredFiles = foundFiles.map((file) => file.filename);

    debugLog(`Filtered to ${filteredFiles.length} files with query.`);
  }

  if (filteredFiles.length === 0) {
    if (!values.quiet) {
      console.log('No files matched the query.');
    }
    process.exit(0);
  }

  if (values['stop-after'] === 'classify') {
    process.exit(0);
  }

  // 4. Process files (with fzf if --fzf is set, otherwise use all filtered files)
  let selectedRelativeFiles: string[] = [];
  if (values.fzf) {
    try {
      await $`which fzf`.quiet();
    } catch (error) {
      console.error('Error: fzf command not found. Please install fzf.');
      process.exit(1);
    }

    const fzfInput = filteredFiles.map((file) => path.relative(baseDir, file)).join('\n');
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
    selectedRelativeFiles = filteredFiles.map((file) => path.relative(baseDir, file));
  }

  // 5. Output Selection
  if (selectedRelativeFiles.length === 0) {
    if (!values.quiet) {
      console.warn('No files selected.');
    }
    process.exit(0);
  }

  if (selectedRelativeFiles.length > 0) {
    // Output absolute paths
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
