#!/usr/bin/env bun
import { $ } from 'bun';
import path from 'node:path';
import clipboard from 'clipboardy';
import { parseArgs } from 'util';
import { generateObject } from 'ai';
import { z } from 'zod';
import { expandPattern, globFiles, grepFor } from '../common/file_finder.ts';
import { createModel } from '../common/model_factory.ts';
import { setDebug, setQuiet } from '../rmfilter/utils.ts';
import { debugLog } from '../logging.ts';
import { encode } from 'gpt-tokenizer';
import { generateGrepTermsFromQuery } from './generate_grep_terms.ts';

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
    yaml: { type: 'boolean' },
    query: { type: 'string', short: 'q' },
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
`);
  process.exit(0);
}

setDebug(values.debug || false);
setQuiet(values.quiet || false);

async function filterFilesWithQuery(
  modelName: string,
  query: string,
  baseDir: string,
  files: string[]
) {
  debugLog(`Filtering ${files.length} files with query: ${query}`);
  try {
    // Read contents of all files
    const fileContents = await Promise.all(
      files.map(async (file) => ({
        path: path.relative(baseDir, file),
        content: await Bun.file(file).text(),
      }))
    );

    // Define schema for AI response
    const schema = z.object({
      relevantFiles: z.array(z.string()),
    });

    // Batch files into groups of roughly 64,000 tokens
    const TOKEN_LIMIT = 64000;
    const batches: { path: string; content: string }[][] = [];
    let currentBatch: { path: string; content: string }[] = [];
    let currentTokenCount = 0;

    const basePromptTokens = encode(`
Given the following files and their contents, select the files that are relevant to the query: "${query}".
Return a list of file paths that match the query.

Files:
`).length;

    for (const file of fileContents) {
      const fileTokens = encode(`Path: ${file.path}\nContent:\n${file.content}\n\n---\n\n`).length;
      if (
        currentTokenCount + fileTokens + basePromptTokens > TOKEN_LIMIT &&
        currentBatch.length > 0
      ) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokenCount = 0;
      }
      currentBatch.push(file);
      currentTokenCount += fileTokens;
    }
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    debugLog(`Created ${batches.length} batches for processing`);

    // Process each batch
    const model = createModel(modelName);
    const allRelevantFiles = new Set<string>();

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      debugLog(`Processing batch ${i + 1} with ${batch.length} files`);

      // Generate prompt for the batch
      const prompt = `
Given the following files and their contents, select the files that are relevant to the query: "${query}".
Return a list of file paths that match the query.

Files:
${batch.map((f) => `Path: ${f.path}\nContent:\n${f.content}`).join('\n\n---\n\n')}

Respond with a JSON object containing a "relevantFiles" array of file paths.
Remember, the query to match is: "${query}"
      `;

      // Query the language model
      const { object } = await generateObject({
        model,
        schema,
        prompt,
        mode: 'json',
      });

      // Collect relevant files from this batch
      object.relevantFiles.forEach((relPath) => allRelevantFiles.add(relPath));
    }

    // Filter files based on AI response
    let filteredFiles = Array.from(allRelevantFiles)
      .map((relPath) => path.resolve(baseDir, relPath))
      .filter((file) => files.includes(file));

    debugLog(`AI filtered to ${filteredFiles.length} files: ${filteredFiles.join(', ')}`);
    return filteredFiles;
  } catch (error) {
    console.error(`Error processing query: ${(error as Error).toString()}`);
    process.exit(1);
  }
}

async function main() {
  try {
    await $`which fzf`.quiet();
  } catch (error) {
    console.error('Error: fzf command not found. Please install fzf.');
    process.exit(1);
  }

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
      grep = await generateGrepTermsFromQuery(values.model, values.query);
      hasGrep = grep.length > 0;
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
        debugLog(`Found ${initialFiles.length} files after grep filtering.`);
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

  // 3. Filter files with natural language query if provided
  let filteredFiles = initialFiles;
  if (values.query) {
    filteredFiles = await filterFilesWithQuery(values.model, values.query, baseDir, filteredFiles);
    debugLog(`Filtered to ${filteredFiles.length} files with query.`);
  }

  if (filteredFiles.length === 0) {
    if (!values.quiet) {
      console.log('No files matched the query.');
    }
    process.exit(0);
  }

  // 4. Run fzf with preview window on the right
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
