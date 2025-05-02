#!/usr/bin/env bun
import { globby } from 'globby';
import { parseArgs } from 'node:util';
import { encode } from 'gpt-tokenizer';
import path from 'node:path';
import { grepFor } from '../common/file_finder.ts';
import { Resolver } from '../dependency_graph/resolve.ts';
import { ImportWalker } from '../dependency_graph/walk_imports.ts';
import {
  diffFilenameInsideFencePrompt,
  diffFilenameOutsideFencePrompt,
} from '../editor/diff-editor/prompts.ts';
import { udiffPrompt } from '../editor/udiff-simple/prompts.ts';
import { generateWholeFilePrompt } from '../editor/whole-file/prompts.ts';
import { xmlFormatPrompt } from '../editor/xml/prompt.ts';
import { debugLog, error, log, warn } from '../logging.ts';
import {
  buildExamplesTag,
  getAdditionalDocs,
  getDiffTag,
  type AdditionalDocsOptions,
} from '../rmfilter/additional_docs.ts';
import { callRepomix, getOutputPath } from '../rmfilter/repomix.ts';
import {
  debug,
  getGitRoot,
  parseCliArgsFromString,
  quiet,
  setDebug,
  setQuiet,
} from '../rmfilter/utils.ts';
import { Extractor } from '../treesitter/extract.ts';
import clipboard from 'clipboardy';
import {
  type CommandParsed,
  type GlobalValues,
  getCurrentConfig,
  listPresets,
  modelPresets,
  resolveModelSettings,
  writeSampleConfig,
} from './config.ts';
import {
  extractFileReferencesFromInstructions,
  getInstructionsFromEditor,
} from './instructions.ts';
import { noArtifacts } from '../editor/fragments.ts';

async function handleInitialCliCommands(globalValues: GlobalValues, yamlConfigPath: string | null) {
  // Handle creation of new YAML config
  if (globalValues.new) {
    // This part remains CLI-only for now, as programmatic execution assumes config is provided.
    let yamlPath = path.resolve(process.cwd(), globalValues.new);
    await writeSampleConfig(yamlPath);
    log(`Created new configuration file at ${yamlPath}`);
    process.exit(0);
  }

  const gitRoot = await getGitRoot();
  // Handle list-presets
  if (globalValues['list-presets']) {
    // This part remains CLI-only.
    await listPresets();
    process.exit(0);
  }

  const modelSettings = resolveModelSettings(globalValues.model);
  if (globalValues.model && modelSettings.isDefault) {
    // User specified an unknown model
    warn(
      `Unexpected --model setting: ${globalValues.model}. Supported values: ${Object.keys(modelPresets).join(', ')}`
    );
  }

  // Validate edit-format
  if (
    globalValues['edit-format'] &&
    !['whole-xml', 'diff', 'diff-orig', 'diff-fenced', 'udiff-simple', 'whole', 'none'].includes(
      globalValues['edit-format']
    )
  ) {
    error(
      `Invalid edit format: ${globalValues['edit-format']}. Must be 'whole-xml', 'diff', 'diff-orig', 'diff-fenced', 'udiff-simple', 'whole', or 'none'`
    );
    process.exit(1);
  }

  if (globalValues.bare) {
    globalValues['omit-cursorrules'] = true;
    globalValues['edit-format'] = 'none';
  }

  // Set up environment
  setDebug(globalValues.debug || false);
  setQuiet(globalValues.quiet || false);
}
function calculateBaseDir(
  globalValues: GlobalValues,
  gitRoot: string,
  yamlConfigPath: string | null
) {
  if (globalValues.cwd) {
    return globalValues.cwd;
  }

  if (globalValues.gitroot) {
    return gitRoot;
  }

  if (yamlConfigPath && yamlConfigPath.startsWith(gitRoot) && !globalValues.preset) {
    // If we use a YAML config, default to the directory of the config file
    return path.dirname(yamlConfigPath);
  }

  return process.cwd();
}

async function processWithImports(
  baseDir: string,
  walker: ImportWalker,
  files: string[],
  allImports: boolean
): Promise<string[]> {
  const results = new Set<string>();
  await Promise.all(
    files.map(async (file) => {
      const filePath = path.resolve(baseDir, file);
      if (allImports) {
        await walker.getImportTree(filePath, results);
      } else {
        const imports = await walker.getDefiningFiles(filePath);
        imports.forEach((imp) => results.add(imp));
      }
    })
  );

  for (let f of files) {
    results.add(f);
  }
  return Array.from(results);
}

async function getNFilesBySize(files: string[], nLargest: number, nSmallest: number) {
  const filesWithSizes = await Promise.all(
    files.map(async (file) => ({
      file,
      size: await Bun.file(file)
        .stat()
        .then((d) => d.size)
        .catch(() => 0),
    }))
  );
  const sorted = filesWithSizes.sort((a, b) => b.size - a.size);

  const largest = nLargest ? sorted.slice(0, nLargest).map((f) => f.file) : [];
  const smallest = nSmallest ? sorted.slice(-nSmallest).map((f) => f.file) : [];

  return { largest, smallest };
}

// Process each command
async function processCommand(
  baseDir: string,
  gitRoot: string,
  cmdParsed: (typeof commandsParsed)[number],
  globalVals: typeof globalValues
): Promise<{ filesSet: Set<string>; examples: { pattern: string; file: string }[] }> {
  const filesSet = new Set<string>();
  const cmdValues = cmdParsed.values;
  let positionals = cmdParsed.positionals.flatMap((p) => p.split(','));

  const ignore = cmdValues.ignore?.map((i) => {
    if (!i.includes('/') && !i.includes('**')) {
      // No existing double-wildcard or slash, so make this match any path.
      return `**/${i}`;
    } else {
      return i;
    }
  });

  if (!quiet) {
    const cmdInfo: string[] = [`positionals=[${cmdParsed.positionals.join(', ')}]`];
    if (cmdParsed.values.grep?.length) {
      cmdInfo.push(`grep=[${cmdParsed.values.grep.join(', ')}]`);
    }
    if (cmdParsed.values.example?.length) {
      cmdInfo.push(`example=[${cmdParsed.values.example.join(', ')}]`);
    }
    if (cmdParsed.values['changed-files']) {
      cmdInfo.push(`changed-files=true`);
    }
    if (ignore?.length) {
      cmdInfo.push(`ignore=[${ignore.join(', ')}]`);
    }
    log(`Command: ${cmdInfo.join(' ')}`);
  }
  const allFoundExamples: { pattern: string; file: string }[] = [];

  if (cmdValues['changed-files']) {
    // Get changed files for this command using the getDiffTag helper
    const { changedFiles } = await getDiffTag(gitRoot, {
      'changed-files': true,
      'diff-from': globalVals['diff-from'],
    });

    if (changedFiles.length > 0) {
      // Convert absolute paths (relative to gitRoot) returned by getDiffTag
      // to paths relative to the current baseDir for globby/grepFor
      const relativeChangedFiles = changedFiles.map((file) =>
        path.relative(baseDir, path.resolve(gitRoot, file))
      );
      positionals.push(...relativeChangedFiles);
      if (!quiet) {
        log(`  Command: Added ${changedFiles.length} changed files to process.`);
      }
    } else if (!quiet) {
      log(`  Command: --changed-files specified, but no changed files found.`);
    }
  }

  // If after potentially adding changed files, we still have no positionals
  // and no other filters (grep/example), then there's nothing to do for this command.
  if (positionals.length === 0 && !cmdValues.grep?.length && !cmdValues.example?.length) {
    if (!quiet) {
      log('  Command: No files, globs, grep, or example patterns specified.');
    }
    return { filesSet, examples: [] };
  }

  const onlyExamples = cmdValues.example?.length && !cmdValues.grep?.length;
  let files: string[] | undefined;

  if (debug) {
    console.time(`Globbing ${positionals.join(', ')}`);
  }

  const globBase = cmdParsed.values.base;
  if (globBase) {
    positionals = positionals.map((p) => path.join(globBase, p));
  }

  let hasGlobs = positionals.some((p) => p.includes('*') || p.includes('?')) || ignore?.length;
  if (hasGlobs) {
    if (positionals.length === 0) {
      // This happens when we have no positionals but we do have an ignore
      positionals = ['**'];
    }

    let withDirGlobs = await Promise.all(
      positionals.map(async (p) => {
        let isDir = await Bun.file(p)
          .stat()
          .then((d) => d.isDirectory())
          .catch(() => false);

        let replaced = p.replaceAll(/\[|\]/g, '\\$&');
        return isDir ? `${replaced}/**` : replaced;
      })
    );

    let ignoreGlobs = await Promise.all(
      ignore?.map(async (p) => {
        let isDir = await Bun.file(p)
          .stat()
          .then((d) => d.isDirectory())
          .catch(() => false);

        let replaced = p.replaceAll(/\[|\]/g, '\\$&');
        return isDir ? `${replaced}/**` : replaced;
      }) || []
    );

    files = await globby(withDirGlobs, {
      cwd: baseDir,
      onlyFiles: true,
      absolute: false,
      dot: false,
      followSymbolicLinks: false,
      ignore: ignoreGlobs.length ? ignoreGlobs : undefined,
      ignoreFiles: ['**/.gitignore', '**/.repomixignore'],
    });

    if (cmdValues.grep && files.length) {
      files = await grepFor(
        baseDir,
        cmdValues.grep,
        files,
        cmdValues.expand ?? false,
        cmdValues['whole-word'] ?? false
      );
    }
  } else if (!onlyExamples) {
    let searchTerms = cmdValues.grep?.length ? cmdValues.grep : ['.'];
    files = await grepFor(baseDir, searchTerms, positionals, false, false);
  }

  if (debug) {
    console.timeEnd(`Globbing ${positionals.join(', ')}`);
  }

  let exampleFiles: Promise<{ pattern: string; files: string[] }[]> | undefined;
  if (cmdValues.example?.length) {
    let values = cmdValues.example.flatMap((p) => p.split(','));
    exampleFiles = Promise.all(
      values.map(async (p) => {
        let matching = await grepFor(baseDir, [p], files || positionals, false, false);

        if (!matching.length) {
          throw new Error(`No files found matching example pattern: ${p}`);
        }

        let {
          largest: [largest],
          smallest: [smallest],
        } = await getNFilesBySize(matching, 1, 1);

        let resultFiles = largest !== smallest ? [largest, smallest] : [largest];

        return {
          pattern: p,
          files: resultFiles,
        };
      })
    );
  }

  // Apply largest filter if specified
  if (files && cmdValues.largest) {
    const n = parseInt(cmdValues.largest as string, 10);
    if (isNaN(n) || n <= 0) {
      error(`Invalid value for --largest: ${cmdValues.largest}. Must be a positive number`);
      process.exit(1);
    }

    files = (await getNFilesBySize(files, n, 0)).largest;
  }

  // Note: Import processing requires absolute paths or paths relative to gitRoot.
  // This needs careful handling if baseDir != gitRoot. For now, assume baseDir is sufficient context.
  if (files) {
    if (cmdValues['with-imports']) {
      // files = await processWithImports(baseDir, walker, files, false); // Walker needs to be available
    } else if (cmdValues['with-all-imports']) {
      files = await processWithImports(files, true);
    }
  }

  let foundExamples = await (exampleFiles ?? []);
  if (foundExamples.length) {
    const examples = foundExamples.flatMap((f) =>
      f.files.map((file) => ({ pattern: f.pattern, file }))
    );
    allFoundExamples.push(...examples);

    if (cmdValues.grep && files) {
      // If we have other filters, then add the example files to the list of files
      files.push(...examples.map((f) => f.file));
    } else {
      // Otherwise, just use the example files so we don't include everything
      files = examples.map((f) => f.file);
    }
  }

  files?.forEach((file) => filesSet.add(file));

  if (filesSet.size === 0) {
    throw new Error(`No files found for file set: ${positionals.join(', ')}`);
  }

  return { filesSet, examples: allFoundExamples };
}

export interface RmfilterConfig {
  globalValues: GlobalValues;
  commandsParsed: CommandParsed[];
  cliArgsString?: string;
}

const getGuidelinesTag = (modelSettings: ReturnType<typeof resolveModelSettings>) => {
  const guidelines = [
    `<guideline>When making a change, update related tests.</guideline>`,
    `<guideline>Leave existing comments and docstrings alone unless updating them is relevant to the change.</guideline>`,
    `<guideline>It is ok for *existing* comments to seem redundant or obvious, as long as they are correct.</guideline>`,
    `<guideline>New comments should explain why something is being done if it isn't obvious. They should not explain what is being done if it is obvious.</guideline>`,
  ];
  if (modelSettings.overeager) {
    guidelines.push(
      `<guideline>Pay careful attention to the scope of the user's request. Do what they ask, but no more. Feel free to add and update tests though as appropriate.</guideline>`
    );
  }
  if (modelSettings.noArtifacts) {
    guidelines.push(`<guideline>${noArtifacts}</guideline>`);
  }
  return `<guidelines>\n${guidelines.join('\n')}\n</guidelines>`;
};

debugLog({
  repomixOutput: repomixOutput.length,
  diffTag: diffTag.length,
  examplesTag: examplesTag.length,
  docsTag: docsTag.length,
  rulesTag: rulesTag.length,
  editFormat: editFormat,
  notBare: !globalValues.bare,
  instructionsTag: instructionsTag.length,
});

const notBare = !globalValues.bare;
export async function generateRmfilterOutput(
  config: RmfilterConfig,
  baseDir: string,
  gitRoot: string
): Promise<string> {
  const { globalValues, commandsParsed, cliArgsString } = config;

  // Resolve model settings based on the config
  const modelSettings = resolveModelSettings(globalValues.model);

  // Set up environment based on config
  setDebug(globalValues.debug || false);
  setQuiet(globalValues.quiet || false);

  // Initialize necessary components
  const resolver = await Resolver.new(gitRoot);
  const walker = new ImportWalker(new Extractor(), resolver);

  // Handle instructions editor (if applicable, though less common for programmatic)
  let editorInstructions = '';
  if (globalValues['instructions-editor']) {
    // This might need adjustment for programmatic use. Assume instructions are passed directly.
    // For now, we'll keep the logic but it might not be hit often.
    editorInstructions = await getInstructionsFromEditor();
    if (editorInstructions.length === 0) {
      throw new Error('Instructions editor requested but no instructions provided');
    }
  }

  // Extract file/dir references from instructions (if any)
  const { files: instructionFiles, directories: instructionDirs } =
    await extractFileReferencesFromInstructions(baseDir, editorInstructions);

  // Add extracted files/dirs as a new command if found
  if (instructionFiles.length > 0 || instructionDirs.length > 0) {
    const newCommandArgs = [...instructionFiles, ...instructionDirs];
    const newCommand: CommandParsed = {
      positionals: newCommandArgs,
      values: {},
    };
    // Add to a mutable copy if needed, or assume commandsParsed is already final
    commandsParsed.push(newCommand);
  }

  if (commandsParsed.length === 0) {
    throw new Error('No commands provided to rmfilter');
  }
  debugLog({ globalValues, commandsParsed });

  // Execute commands and combine results
  const allFilesSet = new Set<string>();
  const allFileDirs = new Set<string>();
  const allExamples: { pattern: string; file: string }[] = [];

  await Promise.all(
    commandsParsed.map(async (cmdParsed) => {
      // Pass baseDir and gitRoot to processCommand
      const cmdFiles = await processCommand(baseDir, gitRoot, cmdParsed, globalValues);
      cmdFiles.filesSet.forEach((file) => {
        const absolutePath = path.resolve(baseDir, file);
        const relativeToGitRoot = path.relative(gitRoot, absolutePath);
        const dirname = path.dirname(relativeToGitRoot);

        // Expand SvelteKit page/layout files
        if (!cmdParsed.values['no-expand-pages']) {
          let filename = path.basename(relativeToGitRoot);
          const svelteDir = path.dirname(absolutePath);
          if (filename == '+page.server.ts' || filename == '+page.ts') {
            allFilesSet.add(path.relative(gitRoot, path.join(svelteDir, '+page.svelte')));
          } else if (filename == '+page.svelte') {
            allFilesSet.add(path.relative(gitRoot, path.join(svelteDir, '+page.server.ts')));
            allFilesSet.add(path.relative(gitRoot, path.join(svelteDir, '+page.ts')));
          } else if (filename == '+layout.server.ts' || filename == '+layout.ts') {
            allFilesSet.add(path.relative(gitRoot, path.join(svelteDir, '+layout.svelte')));
          } else if (filename == '+layout.svelte') {
            allFilesSet.add(path.relative(gitRoot, path.join(svelteDir, '+layout.server.ts')));
            allFilesSet.add(path.relative(gitRoot, path.join(svelteDir, '+layout.ts')));
          }
        }

        allFilesSet.add(relativeToGitRoot);
        allFileDirs.add(dirname);
      });
      allExamples.push(
        ...cmdFiles.examples.map((ex) => ({
          ...ex,
          file: path.relative(gitRoot, path.resolve(baseDir, ex.file)),
        }))
      );
    })
  );

  // Add package.json for the relevant files
  await Promise.all(
    Array.from(allFileDirs, async (d) => {
      try {
        // Resolve package.json relative to gitRoot
        let pkg = await resolver.resolvePackageJson(path.resolve(gitRoot, d));
        if (pkg?.path) {
          allFilesSet.add(path.relative(gitRoot, path.join(pkg.path, 'package.json')));
        }
      } catch {
        // it's fine if there is no package.json
      }
    })
  );

  // Filter out non-existent files that might have been added by expansion
  const existingFiles = new Set<string>();
  await Promise.all(
    Array.from(allFilesSet).map(async (relPath) => {
      try {
        const absPath = path.resolve(gitRoot, relPath);
        (await Bun.file(absPath).exists()) && existingFiles.add(relPath);
      } catch {
        /* ignore errors */
      }
    })
  );

  const allPaths = Array.from(existingFiles);

  if (!allPaths.length && !globalValues['with-diff']) {
    // Only throw error if no files AND no diff requested
    throw new Error('No files found and no diff requested');
  }

  const editFormat =
    globalValues['edit-format'] || modelSettings.defaultEditFormat || 'udiff-simple';

  // Fetch additional docs, diff tag, and examples tag
  const additionalDocsOptions: AdditionalDocsOptions = {
    ...globalValues,
    // Combine instructions from config and potentially editor
    instructions: (globalValues.instructions || []).concat(editorInstructions),
  };

  // Pass paths relative to gitRoot to getAdditionalDocs, but baseDir context is still needed
  const [
    { docsTag, instructionsTag, rulesTag, rawInstructions, docFilesPaths, ruleFilesPaths },
    { diffTag },
    examplesTag,
  ] = await Promise.all([
    getAdditionalDocs(baseDir, existingFiles, additionalDocsOptions),
    getDiffTag(gitRoot, {
      'with-diff': globalValues['with-diff'],
      'diff-from': globalValues['diff-from'],
    }),
    buildExamplesTag(
      allExamples.map((ex) => ({
        ...ex,
        // file path is already relative to gitRoot from processing step
      }))
    ),
  ]);

  const compress = globalValues.compress ? '--compress' : '';

  // Call repomix with paths relative to gitRoot
  const repomixOutput = allPaths.length
    ? await callRepomix(
        gitRoot,
        rawInstructions,
        ['--top-files-len', '20', compress, '--include', allPaths.join(',')].filter((v) => v)
      )
    : '';

  const notBare = !globalValues.bare;

  // Construct command tag using provided cliArgsString or reconstruct if needed
  const commandTagContent =
    cliArgsString ?? reconstructCliArgs(globalValues, commandsParsed, editorInstructions);
  const commandTag = `The rmfilter_command tag contains the CLI arguments used to generate these instructions. You should place this tag and its contents at the start of your output.
<rmfilter_command>${commandTagContent}</rmfilter_command>`;

  const finalOutput = [
    repomixOutput,
    diffTag,
    examplesTag,
    docsTag,
    rulesTag,
    editFormat === 'whole-xml' && notBare ? xmlFormatPrompt(modelSettings) : '',
    editFormat === 'diff' && notBare ? diffFilenameInsideFencePrompt(modelSettings) : '',
    editFormat === 'diff-orig' && notBare ? diffFilenameOutsideFencePrompt(modelSettings) : '',
    editFormat === 'diff-fenced' && notBare ? diffFilenameInsideFencePrompt(modelSettings) : '',
    editFormat === 'udiff-simple' && notBare ? udiffPrompt(modelSettings) : '',
    editFormat === 'whole-file' && notBare ? generateWholeFilePrompt(modelSettings) : '',
    notBare ? getGuidelinesTag(modelSettings) : '',
    notBare ? commandTag : '',
    instructionsTag,
  ]
    .filter(Boolean)
    .join('\n\n');

  // Log info if not quiet (moved outside this function in the main block)

  return finalOutput;
}

// Helper to quote args for reconstruction
function quoteArg(arg: string): string {
  if (arg.includes(' ') && !arg.startsWith('"') && !arg.endsWith('"')) {
    // Escape existing double quotes and wrap the argument in double quotes
    const escapedArg = arg.replace(/"/g, '\\"');
    return `"${escapedArg}"`;
  }
  // Escape double quotes in the argument even if it doesn't need wrapping
  return arg.replace(/"/g, '\\"');
}

// Helper to reconstruct CLI args string from parsed config
function reconstructCliArgs(
  globalValues: GlobalValues,
  commandsParsed: CommandParsed[],
  editorInstructions: string
): string {
  const args: string[] = [];

  // Add global options
  for (const [key, value] of Object.entries(globalValues)) {
    if (value === true) {
      args.push(`--${key}`);
    } else if (typeof value === 'string') {
      if (key === 'instructions' && value === editorInstructions) {
        // Special handling if instructions came from editor originally
        args.push(`--instructions ${quoteArg(value)}`);
      } else if (key !== 'instructions') {
        args.push(`--${key} ${quoteArg(value)}`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((v) => args.push(`--${key} ${quoteArg(v)}`));
    }
    // Ignore false, null, undefined values
  }

  // Add commands
  commandsParsed.forEach((cmd) => {
    cmd.positionals.forEach((p) => args.push(quoteArg(p)));
    for (const [key, value] of Object.entries(cmd.values)) {
      if (value === true) {
        args.push(`--${key}`);
      } else if (typeof value === 'string') {
        args.push(`--${key} ${quoteArg(value)}`);
      } else if (Array.isArray(value)) {
        value.forEach((v) => args.push(`--${key} ${quoteArg(v)}`));
      }
    }
    args.push('--');
  });

  // Remove trailing '--' if it exists
  if (args.length > 0 && args[args.length - 1] === '--') {
    args.pop();
  }

  return args.join(' ');
}

export async function runRmfilterProgrammatically(
  args: string[],
  gitRoot: string,
  baseDir: string
): Promise<string> {
  // Define options similar to getCurrentConfig but without YAML/preset logic
  const options = {
    // Global options
    output: { type: 'string', short: 'o' },
    model: { type: 'string', short: 'm' },
    'edit-format': { type: 'string', short: 'f' },
    'with-diff': { type: 'boolean', short: 'd' },
    'diff-from': { type: 'string' },
    instructions: { type: 'string', short: 'i', multiple: true },
    'instructions-editor': { type: 'boolean' },
    docs: { type: 'string', multiple: true },
    rules: { type: 'string', multiple: true },
    copy: { type: 'boolean', short: 'c' },
    quiet: { type: 'boolean', short: 'q' },
    debug: { type: 'boolean' },
    compress: { type: 'boolean' },
    bare: { type: 'boolean' },
    'omit-cursorrules': { type: 'boolean' },
    cwd: { type: 'string' },
    gitroot: { type: 'boolean' },
    // Command-specific options (need to be handled per command segment)
    grep: { type: 'string', short: 'g', multiple: true },
    example: { type: 'string', short: 'e', multiple: true },
    ignore: { type: 'string', multiple: true },
    'with-imports': { type: 'boolean' },
    'with-all-imports': { type: 'boolean' },
    'changed-files': { type: 'boolean' },
    largest: { type: 'string' },
    base: { type: 'string' },
    'no-expand-pages': { type: 'boolean' },
  } as const;

  // Basic parsing - This won't handle command separation ('--') correctly like getCurrentConfig.
  // We need to manually split args by '--' and parse each segment.
  const commandSegments: string[][] = [];
  let currentSegment: string[] = [];
  for (const arg of args) {
    if (arg === '--') {
      commandSegments.push(currentSegment);
      currentSegment = [];
    } else {
      currentSegment.push(arg);
    }
  }
  commandSegments.push(currentSegment);

  // Parse the first segment for global options
  const { values: parsedGlobalValues, positionals: firstCmdPositionals } = parseArgs({
    args: commandSegments[0],
    options,
    allowPositionals: true,
    strict: false,
  });

  const globalValues: GlobalValues = parsedGlobalValues as GlobalValues;
  const commandsParsed: CommandParsed[] = [];

  // Process the first command (positionals from global parse + options from its segment)
  const { values: firstCmdValues } = parseArgs({
    args: commandSegments[0],
    options,
    allowPositionals: true,
    strict: false,
  });
  commandsParsed.push({ positionals: firstCmdPositionals, values: firstCmdValues });

  // Process subsequent command segments
  for (let i = 1; i < commandSegments.length; i++) {
    const { values: cmdValues, positionals: cmdPositionals } = parseArgs({
      args: commandSegments[i],
      options,
      allowPositionals: true,
      strict: false,
    });
    commandsParsed.push({ positionals: cmdPositionals, values: cmdValues });
  }

  // Construct the config object
  const config: RmfilterConfig = {
    globalValues,
    commandsParsed,
    cliArgsString: args.join(' '),
  };

  // Call the refactored core logic
  return generateRmfilterOutput(config, baseDir, gitRoot);
}

// Main execution block (CLI entry point)
async function main() {
  const { globalValues, commandsParsed, yamlConfigPath } = await getCurrentConfig();
  await handleInitialCliCommands(globalValues, yamlConfigPath);

  const gitRoot = await getGitRoot();
  const baseDir = calculateBaseDir(globalValues, gitRoot, yamlConfigPath);
  const modelSettings = resolveModelSettings(globalValues.model);

  // Reconstruct the original CLI arguments string for the command tag
  let editorInstructionsForCmdTag = '';
  if (globalValues['instructions-editor']) {
    // Need to fetch this again if it was used, solely for the command tag reconstruction.
    // This is slightly awkward but necessary if we want the tag to reflect the editor input.
    // Alternatively, the caller of runRmfilterProgrammatically could pass the resolved instructions.
    editorInstructionsForCmdTag = await getInstructionsFromEditor().catch(() => '');
  }
  const cliArgsString = reconstructCliArgs(
    globalValues,
    commandsParsed,
    editorInstructionsForCmdTag
  );

  const config: RmfilterConfig = {
    globalValues,
    commandsParsed,
    cliArgsString,
  };

  const finalOutput = await generateRmfilterOutput(config, baseDir, gitRoot);

  // Handle output writing/copying
  const outputFile = globalValues.output ?? (await getOutputPath());
  await Bun.write(outputFile, finalOutput);

  // Logging (conditionally based on quiet flag) - Extract info needed for logging
  // This requires generateRmfilterOutput to potentially return more info or re-calculating some parts.
  // For simplicity now, we'll skip detailed logging here, assuming generateRmfilterOutput handles internal logging.
  // A more robust solution would involve generateRmfilterOutput returning a result object.
  if (!globalValues.quiet) {
    // Basic logging based on config and output file
    const editFormat =
      globalValues['edit-format'] || modelSettings.defaultEditFormat || 'udiff-simple';
    const tokens = encode(finalOutput);
    log('\n## OUTPUT');
    log(`Tokens: ${tokens.length}`);
    log(`Output written to ${outputFile}, edit format: ${editFormat}`);

    // Re-fetch doc/rule paths if needed for logging (example)
    // const { docFilesPaths, ruleFilesPaths } = await getAdditionalDocs(baseDir, /* need fileset */, { ... });
    /*
    if (docFilesPaths.length) {
    log('\n## DOCUMENTS');
    for (const doc of docFilesPaths) {
      log(`- ${doc}`);
    }
  }

  if (ruleFilesPaths.length) {
    log('\n## RULES');
    for (const rule of ruleFilesPaths) {
      log(`- ${rule}`);
    }
  }
    if (globalValues.instructions?.length) {
    log('\n## INSTRUCTIONS');
    log(globalValues.instructions.join('\n'));
    }
    */
  }

  if (globalValues.copy) {
    await clipboard.write(finalOutput);
    if (!globalValues.quiet) {
      log('Output copied to clipboard');
    }
  }
}

// Execute main only if the script is run directly
if (import.meta.main) {
  main().catch((err) => {
    error(err.message);
    if (debug) {
      console.error(err.stack);
    }
    process.exit(1);
  });
}
