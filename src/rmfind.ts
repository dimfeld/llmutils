#!/usr/bin/env bun
import { $ } from 'bun';
import path from 'node:path';
import clipboard from 'clipboardy';
import { parseArgs } from 'util';
import { globFiles, grepFor } from './common/file_finder.ts';
import { setDebug, setQuiet } from './rmfilter/utils.ts';
import { debugLog } from './logging.ts';

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
    quiet: { type: 'boolean', short: 'q' },
    yaml: { type: 'boolean' },
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
  --cwd <dir>            Set working directory.
  --gitroot              Use Git root as working directory.
  -h, --help             Show this help message.
  --debug                Print debug information.
  -q, --quiet            Suppress informational output (fzf UI still shown).
  --yaml                 Output a YAML array instead of space-separated
`);
  process.exit(0);
}

setDebug(values.debug || false);
setQuiet(values.quiet || false);

async function main() {
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
  const grep = values.grep ?? [];
  const hasGrep = values.grep && values.grep.length > 0;

  if (!hasGlobs && !hasGrep) {
    console.error('Error: No globs, directories, or grep patterns provided.');
    console.error('Use --help for usage information.');
    process.exit(1);
  }

  try {
    if (hasGlobs) {
      debugLog(
        `Globbing patterns: ${positionals.join(', ')} with ignore: ${values.ignore?.join(', ')}`
      );
      initialFiles = await globFiles(baseDir, positionals, values.ignore);
      debugLog(`Found ${initialFiles.length} files via globbing.`);
      // If grep is also specified, filter the globbed files
      if (hasGrep) {
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
        debugLog(`Found ${initialFiles.length} files after grep filtering.`);
      }
    } else if (hasGrep) {
      // Only grep is specified, search the base directory
      debugLog(`Grepping base directory for patterns: ${grep.join(', ')}`);
      initialFiles = await grepFor(
        baseDir,
        grep,
        undefined, // Search baseDir
        values.expand ?? false,
        values['whole-word'] ?? false
      );
      debugLog(`Found ${initialFiles.length} files via grep.`);
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

  // 3. Check for fzf
  try {
    await $`which fzf`.quiet();
  } catch (error) {
    console.error('Error: fzf command not found. Please install fzf.');
    process.exit(1);
  }

  // 4. Run fzf
  const fzfInput = initialFiles.map((file) => path.relative(baseDir, file)).join('\n');
  const fzfProc = Bun.spawn(['fzf', '--multi', '--ansi', '--tac'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit', // Show fzf UI errors
    cwd: baseDir,
  });

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
  }

  // 5. Process and Output Selection
  const selectedRelativeFiles = fzfOutput.trim().split('\n').filter(Boolean);

  if (selectedRelativeFiles.length > 0) {
    // Output space-separated absolute paths
    let output: string;
    if (values.yaml) {
      output = selectedRelativeFiles.map((file) => `    - "${file}"`).join('\n');
    } else {
      output = selectedRelativeFiles.join(' ');
    }

    await clipboard.write(output);
    console.log(output);
  }
}

main().catch((err) => {
  console.error('An unexpected error occurred:', err);
  process.exit(1);
});
