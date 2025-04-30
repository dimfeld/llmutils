#!/usr/bin/env bun
import { globby } from 'globby';
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
import { debugLog, error, log } from '../logging.ts';
import { buildExamplesTag, getAdditionalDocs, getDiffTag } from '../rmfilter/additional_docs.ts';
import { callRepomix, getOutputPath } from '../rmfilter/repomix.ts';
import { debug, getGitRoot, quiet, setDebug, setQuiet } from '../rmfilter/utils.ts';
import { Extractor } from '../treesitter/extract.ts';
import clipboard from 'clipboardy';
import {
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

const { globalValues, commandsParsed, yamlConfigPath } = await getCurrentConfig();

// Handle creation of new YAML config
if (globalValues.new) {
  let yamlPath = path.resolve(process.cwd(), globalValues.new);
  await writeSampleConfig(yamlPath);
  log(`Created new configuration file at ${yamlPath}`);
  process.exit(0);
}

const gitRoot = await getGitRoot();

// Handle list-presets
if (globalValues['list-presets']) {
  await listPresets();
  process.exit(0);
}

if (globalValues.model && !Object.keys(modelPresets).includes(globalValues.model)) {
  error(
    `Invalid model: ${globalValues.model}. Must be one of ${Object.keys(modelPresets).join(', ')}`
  );
  process.exit(1);
}

const modelSettings = resolveModelSettings(globalValues.model);

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

function calculateBaseDir() {
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

const baseDir = calculateBaseDir();

// Handle instructions editor
let editorInstructions = '';
if (globalValues['instructions-editor']) {
  editorInstructions = await getInstructionsFromEditor();

  if (editorInstructions.length === 0) {
    error('No instructions provided');
    process.exit(1);
  }
}

// Extract file and directory references from instructions
const { files, directories } = await extractFileReferencesFromInstructions(
  baseDir,
  editorInstructions
);

if (files.length > 0 || directories.length > 0) {
  // Create a new command with the extracted paths as positionals
  const newCommandArgs = [...files, ...directories];
  const newCommand = {
    positionals: newCommandArgs,
    values: {},
  };
  commandsParsed.push(newCommand);
}

if (commandsParsed.length === 0) {
  error('No commands provided');
  process.exit(1);
}
debugLog({ globalValues, commandsParsed });

const resolver = await Resolver.new(gitRoot);
const walker = new ImportWalker(new Extractor(), resolver);
async function processWithImports(files: string[], allImports: boolean): Promise<string[]> {
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
  cmdParsed: (typeof commandsParsed)[number],
  globalVals: typeof globalValues // Pass global values for context like diff-from
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
      'changed-files': true, // Indicate we need the list
      'diff-from': globalVals['diff-from'], // Use global diff-from if set
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
    const n = parseInt(cmdValues.largest, 10);
    if (isNaN(n) || n <= 0) {
      error(`Invalid value for --largest: ${cmdValues.largest}. Must be a positive number`);
      process.exit(1);
    }

    files = (await getNFilesBySize(files, n, 0)).largest;
  }

  if (files) {
    if (cmdValues['with-imports']) {
      files = await processWithImports(files, false);
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

// Execute commands and combine results
const allFilesSet = new Set<string>();
const allFileDirs = new Set<string>();
const allExamples: { pattern: string; file: string }[] = [];
await Promise.all(
  commandsParsed.map(async (cmdParsed) => {
    const cmdFiles = await processCommand(cmdParsed, globalValues);
    cmdFiles.filesSet.forEach((file) => {
      const dirname = path.dirname(file);

      if (!cmdParsed.values['no-expand-pages']) {
        let filename = path.basename(file);
        if (filename == '+page.server.ts' || filename == '+page.ts') {
          allFilesSet.add(path.join(dirname, '+page.svelte'));
        } else if (filename == '+page.svelte') {
          allFilesSet.add(path.join(dirname, '+page.server.ts'));
          allFilesSet.add(path.join(dirname, '+page.ts'));
        } else if (filename == '+layout.server.ts' || filename == '+layout.ts') {
          allFilesSet.add(path.join(dirname, '+layout.svelte'));
        } else if (filename == '+layout.svelte') {
          allFilesSet.add(path.join(dirname, '+layout.server.ts'));
          allFilesSet.add(path.join(dirname, '+layout.ts'));
        }
      }

      allFilesSet.add(file);
      allFileDirs.add(dirname);
    });
    allExamples.push(...cmdFiles.examples);
  })
);

// Add package.json for the relevant files to help inform the model about imports
await Promise.all(
  Array.from(allFileDirs, async (d) => {
    try {
      let pkg = await resolver.resolvePackageJson(d);
      if (pkg?.path) {
        allFilesSet.add(path.join(pkg.path, 'package.json'));
      }
    } catch {
      // it's fine if there is no package.json since we're not always in JS
    }
  })
);

// Handle output
const outputFile = globalValues.output ?? (await getOutputPath());
const editFormat = globalValues['edit-format'] || modelSettings.defaultEditFormat || 'udiff-simple';

const longestPatternLen = allExamples.reduce((a, b) => Math.max(a, b.pattern.length), 0);

// Fetch additional docs, diff tag (if requested globally), and examples tag
const [
  { docsTag, instructionsTag, rulesTag, rawInstructions, docFilesPaths, ruleFilesPaths },
  { diffTag },
  examplesTag,
] = await Promise.all([
  getAdditionalDocs(baseDir, allFilesSet, {
    ...globalValues,
    instructions: (globalValues.instructions || []).concat(editorInstructions),
  }),
  getDiffTag(gitRoot, {
    'with-diff': globalValues['with-diff'],
    'diff-from': globalValues['diff-from'],
  }),
  buildExamplesTag(allExamples),
]);

const allPaths = Array.from(allFilesSet, (p) => path.relative(gitRoot, p));

if (!allPaths.length && !globalValues['with-diff']) {
  error('No files found');
  process.exit(1);
}

const compress = globalValues.compress ? '--compress' : '';

// Call repomix
const repomixOutput = allPaths.length
  ? await callRepomix(
      gitRoot,
      rawInstructions,
      ['--top-files-len', '20', compress, '--include', allPaths.join(',')].filter((v) => v)
    )
  : '';

const getGuidelinesTag = () => {
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
  notBare ? getGuidelinesTag() : '',
  instructionsTag,
]
  .filter(Boolean)
  .join('\n\n');

await Bun.write(outputFile, finalOutput);

if (!globalValues.quiet) {
  if (allExamples.length) {
    log('\n## EXAMPLES');
    for (let { pattern, file } of allExamples) {
      log(`${(pattern + ':').padEnd(longestPatternLen + 1)} ${file}`);
    }
  }

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

  if (rawInstructions) {
    log('\n## INSTRUCTIONS');
    log(rawInstructions);
  }

  const tokens = encode(finalOutput);
  log('\n## OUTPUT');
  log(`Tokens: ${tokens.length}`);
  log(`Output written to ${outputFile}, edit format: ${editFormat}`);
}

if (globalValues.copy) {
  await clipboard.write(finalOutput);
  if (!globalValues.quiet) {
    log('Output copied to clipboard');
  }
}
