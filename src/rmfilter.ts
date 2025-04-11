#!/usr/bin/env bun
import { $ } from 'bun';
import * as changeCase from 'change-case';
import { glob } from 'glob';
import { encode } from 'gpt-tokenizer';
import path from 'node:path';
import { parseArgs } from 'util';
import { Resolver } from './dependency_graph/resolve.ts';
import { ImportWalker } from './dependency_graph/walk_imports.ts';
import { generateSearchReplacePrompt } from './diff-editor/prompts';
import { buildExamplesTag, getAdditionalDocs, getDiffTag } from './rmfilter/additional_docs.ts';
import { callRepomix, getOutputPath } from './rmfilter/repomix.ts';
import { logSpawn, setDebug, setQuiet } from './rmfilter/utils.ts';
import { Extractor } from './treesitter/extract.ts';
import { generateWholeFilePrompt } from './whole-file/prompts';
import { xmlFormatPrompt } from './xml/prompt';
import { debugLog } from './logging.ts';
import { parse } from 'yaml';
import { z } from 'zod';

import fs from 'node:fs/promises';
import os from 'node:os';

// Define global options
const globalOptions = {
  'edit-format': { type: 'string', short: 'f' },
  output: { type: 'string', short: 'o' },
  copy: { type: 'boolean', short: 'c' },
  cwd: { type: 'string' },
  gitroot: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  debug: { type: 'boolean' },
  instructions: { type: 'string', multiple: true },
  instruction: { type: 'string', short: 'i', multiple: true },
  docs: { type: 'string', multiple: true },
  rules: { type: 'string', multiple: true },
  'omit-cursorrules': { type: 'boolean' },
  'with-diff': { type: 'boolean' },
  'changed-files': { type: 'boolean' },
  'diff-from': { type: 'string' },
  'instructions-editor': { type: 'boolean' },
  'omit-instructions-tag': { type: 'boolean' },
  bare: { type: 'boolean' },
  config: { type: 'string' },
  preset: { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  'list-presets': { type: 'boolean' },
} as const;

// Define command-specific options
const commandOptions = {
  grep: { type: 'string', short: 'g', multiple: true },
  'whole-word': { type: 'boolean', short: 'w' },
  expand: { type: 'boolean', short: 'e' },
  'no-expand-pages': { type: 'boolean' },
  'with-imports': { type: 'boolean' },
  'with-all-imports': { type: 'boolean' },
  upstream: { type: 'string', multiple: true },
  downstream: { type: 'string', multiple: true },
  largest: { type: 'string', short: 'l' },
  example: { type: 'string', multiple: true },
} as const;

// Zod schemas for YAML validation
// Put this comment at the top of your YAML file to reference the schema:
// # yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmfilter-config-schema.json
const CommandConfigSchema = z
  .object({
    globs: z.string().array().optional(),
    grep: z.union([z.string(), z.string().array()]).optional(),
    'whole-word': z.boolean().optional(),
    expand: z.boolean().optional(),
    'no-expand-pages': z.boolean().optional(),
    'with-imports': z.boolean().optional(),
    'with-all-imports': z.boolean().optional(),
    upstream: z.union([z.string(), z.string().array()]).optional(),
    downstream: z.union([z.string(), z.string().array()]).optional(),
    largest: z.string().optional(),
    example: z.union([z.string(), z.string().array()]).optional(),
  })
  .strict();

const ConfigSchema = z
  .object({
    description: z.string().optional(),
    'edit-format': z.enum(['whole-xml', 'diff', 'whole', 'none']).optional(),
    output: z.string().optional(),
    copy: z.boolean().optional(),
    quiet: z.boolean().optional(),
    cwd: z.string().optional(),
    gitroot: z.boolean().optional(),
    debug: z.boolean().optional(),
    instructions: z.union([z.string(), z.string().array()]).optional(),
    instruction: z.union([z.string(), z.string().array()]).optional(),
    docs: z.union([z.string(), z.string().array()]).optional(),
    rules: z.union([z.string(), z.string().array()]).optional(),
    'omit-cursorrules': z.boolean().optional(),
    'omit-instructions-tag': z.boolean().optional(),
    'with-diff': z.boolean().optional(),
    'changed-files': z.boolean().optional(),
    'diff-from': z.string().optional(),
    'instructions-editor': z.boolean().optional(),
    bare: z.boolean().optional(),
    commands: CommandConfigSchema.array().optional(),
  })
  .strict();

// Parse global options and collect all positionals
const allArgs = process.argv.slice(2);
const globalAllArgs = allArgs.filter((arg) => {
  if (arg === '--') {
    return false;
  }

  if (arg.startsWith('--')) {
    // omit any command options
    if (commandOptions[arg.slice(2) as keyof typeof commandOptions]) {
      return false;
    }
  }

  return true;
});
// Get global args from all the commands regardless of where they are
const parsedGlobal = parseArgs({
  options: globalOptions,
  allowPositionals: true,
  args: globalAllArgs,
});
let globalValues = parsedGlobal.values;

const gitRoot = (await $`git rev-parse --show-toplevel`.nothrow().text()).trim() || process.cwd();

// Function to search for preset YAML file
async function findPresetFile(preset: string, gitRoot: string): Promise<string | null> {
  let currentDir = process.cwd();
  const gitRootDir = path.resolve(gitRoot);

  // Search from current directory up to git root
  while (currentDir.startsWith(gitRootDir) || currentDir === gitRootDir) {
    const presetPath = path.join(currentDir, '.rmfilter', `${preset}.yml`);
    try {
      await fs.access(presetPath);
      return presetPath;
    } catch {
      // Move up to parent directory
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break; // Reached root
      currentDir = parentDir;
    }
  }

  const homeConfigDir = path.join(os.homedir(), '.config', 'rmfilter');
  const homePresetPath = path.join(homeConfigDir, `${preset}.yml`);
  try {
    await fs.access(homePresetPath);
    return homePresetPath;
  } catch {
    // Ignore error if file doesn't exist
  }

  return null;
}

// Function to find all preset files
async function findAllPresetFiles(
  gitRoot: string
): Promise<{ name: string; description: string | undefined }[]> {
  const presets = new Map<string, string>();
  let currentDir = process.cwd();
  const gitRootDir = path.resolve(gitRoot);
  const homeConfigDir = path.join(os.homedir(), '.config', 'rmfilter');

  const searchDirs: string[] = [];

  // Collect directories from current path up to git root
  while (currentDir.startsWith(gitRootDir) || currentDir === gitRootDir) {
    searchDirs.push(path.join(currentDir, '.rmfilter'));
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break; // Reached root
    currentDir = parentDir;
  }

  // Add home config dir
  searchDirs.push(homeConfigDir);

  // Use glob to find all .yml files in these directories
  for (const dir of searchDirs) {
    try {
      const files = await glob('*.yml', { cwd: dir, absolute: true });
      files.forEach((file) => {
        presets.set(path.basename(file, '.yml'), file);
      });
    } catch (e) {
      // Ignore errors like directory not found
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        debugLog(`Error searching directory ${dir}: ${e}`);
      }
    }
  }

  const items = await Promise.all(
    Array.from(presets.entries()).map(async ([presetName, path]) => {
      const data = await Bun.file(path).text();
      const parsedConfig = parse(data);
      const config = ConfigSchema.parse(parsedConfig);
      return {
        name: presetName,
        description: config.description,
      };
    })
  );

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

// Load YAML config if provided
let yamlCommands: string[][] = [];
let yamlConfigPath: string | undefined;
if (globalValues.preset || globalValues.config) {
  try {
    if (globalValues.preset) {
      const presetPath = await findPresetFile(globalValues.preset, gitRoot);
      if (!presetPath) {
        console.error(
          `Preset '${globalValues.preset}' not found in .rmfilter/ directories or $HOME/.config/rmfilter/`
        );
        process.exit(1);
      }
      yamlConfigPath = presetPath;
    } else if (globalValues.config) {
      yamlConfigPath = path.resolve(process.cwd(), globalValues.config);
    }

    if (yamlConfigPath) {
      const configFile = await Bun.file(yamlConfigPath).text();
      const parsedConfig = parse(configFile);
      const config = ConfigSchema.parse(parsedConfig);

      // Merge YAML global options with CLI global options (CLI takes precedence)
      globalValues = {
        ...config,
        ...globalValues,
        instruction: undefined,
        // Merge arrays for options that support multiple values
        instructions: [
          ...(config.instructions
            ? Array.isArray(config.instructions)
              ? config.instructions
              : [config.instructions]
            : []),
          ...(config.instruction
            ? Array.isArray(config.instruction)
              ? config.instruction
              : [config.instruction]
            : []),
          ...(globalValues.instructions || []),
          ...(globalValues.instruction || []),
        ].filter(Boolean),
        docs: [
          ...(config.docs ? (Array.isArray(config.docs) ? config.docs : [config.docs]) : []),
          ...(globalValues.docs || []),
        ].filter(Boolean),
        rules: [
          ...(config.rules ? (Array.isArray(config.rules) ? config.rules : [config.rules]) : []),
          ...(globalValues.rules || []),
        ].filter(Boolean),
      };

      // Convert YAML commands to argument arrays
      if (config.commands) {
        yamlCommands = config.commands.map((cmd) => {
          const args: string[] = [];
          if (cmd.globs) {
            args.push(...(Array.isArray(cmd.globs) ? cmd.globs : [cmd.globs]));
          }
          for (const [key, value] of Object.entries(cmd)) {
            if (key === 'globs') continue;
            if (value === undefined || value === null) continue;
            const flag = `--${key}`;
            if (typeof value === 'boolean') {
              if (value) args.push(flag);
            } else if (Array.isArray(value)) {
              value.forEach((v) => {
                args.push(flag, v.toString());
              });
            } else {
              args.push(flag, value.toString());
            }
          }
          return args;
        });
      }
    }
  } catch (error) {
    console.error(`Failed to load YAML config: ${(error as Error).message}`);
    process.exit(1);
  }
}

// Handle help message
if (globalValues.help) {
  console.log(
    'usage: rmfilter [global options] [files/globs [command options]] [-- [files/globs [command options]]] ...'
  );
  console.log('\nGlobal Options:');
  console.log('  --config <file>           Load configuration from YAML file');
  console.log(
    '  --preset <name>           Load preset YAML config from .rmfilter/<name>.yml or $HOME/.config/rmfilter/<name>.yml'
  );
  console.log(
    '  --edit-format <format>    Set edit format (whole-xml, diff, whole) or "none" to omit'
  );
  console.log('  -o, --output <file>       Specify output file');
  console.log('  -c, --copy               Copy output to clipboard');
  console.log('  --cwd <dir>               Set working directory');
  console.log('  --gitroot                 Use Git root as working directory');
  console.log('  --bare                    Omit all extra rules and formatting instructions');
  console.log('  -h, --help                Show this help message');
  console.log('  --list-presets            List available presets and exit');
  console.log('  --debug                   Print executed commands');
  console.log('  -q, --quiet               Suppress all output from tool and spawned processes');
  console.log('  --with-diff               Include Git diff against main/master in output');
  console.log('  --changed-files           Include all changed files');
  console.log('  --diff-from (<branch>|<rev>) Diff from <branch> instead of main');
  console.log('  -i, --instructions <text> Add instructions (prefix @ for files)');
  console.log('  --docs <globs>            Add documentation files');
  console.log('  --rules <globs>           Add rules files');
  console.log('  --omit-cursorrules        Skip loading .cursorrules');
  console.log('  --instructions-editor     Open editor for instructions in $EDITOR');
  console.log('\nCommand Options (per command):');
  console.log('  -g, --grep <patterns>     Include files matching these patterns');
  console.log('  -w, --whole-word          Match whole words in grep');
  console.log('  -e, --expand              Expand grep patterns (snake_case, camelCase)');
  console.log('  --no-expand-pages         Disable inclusion of matching page/server route files');
  console.log('  --with-imports            Include direct imports of files');
  console.log('  --with-all-imports        Include entire import tree');
  console.log('  --upstream <pkgs>         Include upstream dependencies');
  console.log('  --downstream <pkgs>       Include downstream dependents');
  console.log('  -l, --largest <number>    Keep only the N largest files');
  console.log('  --example <pattern>       Include the largest file that matches the pattern.');
  console.log('');
  process.exit(0);
}

// Handle list-presets
if (globalValues['list-presets']) {
  const presets = await findAllPresetFiles(gitRoot);
  if (presets.length > 0) {
    console.log('Available presets:');
    const longestNameLength = presets.reduce((max, preset) => Math.max(max, preset.name.length), 0);

    presets.forEach((preset) => {
      if (preset.description) {
        console.log(`${preset.name.padEnd(longestNameLength, ' ')}   ${preset.description}`);
      } else {
        console.log(`${preset.name.padEnd(longestNameLength, ' ')}`);
      }
    });
  } else {
    console.log('No presets found.');
  }
  process.exit(0);
}

// Validate edit-format
if (
  globalValues['edit-format'] &&
  !['whole-xml', 'diff', 'whole', 'none'].includes(globalValues['edit-format'])
) {
  console.error(
    `Invalid edit format: ${globalValues['edit-format']}. Must be 'whole-xml', 'diff', 'whole', or 'none'`
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

  if (yamlConfigPath && yamlConfigPath.startsWith(gitRoot)) {
    // If we use a YAML config, default to the directory of the config file
    return path.dirname(yamlConfigPath);
  }

  return process.cwd();
}

const baseDir = calculateBaseDir();

// Handle instructions editor
let editorInstructions = '';
if (globalValues['instructions-editor']) {
  const instructionsFile = path.join(gitRoot, 'repomix-instructions.md');
  const editor = process.env.EDITOR || 'nano';
  let editorProcess = logSpawn([editor, instructionsFile], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  await editorProcess.exited;
  editorInstructions = (await Bun.file(instructionsFile).text()).trim();

  if (editorInstructions.length === 0) {
    console.error('No instructions provided');
    process.exit(1);
  }
}

// Split positionals into commands
const commands: string[][] = [];
let currentCommand: string[] = [];
for (const arg of allArgs) {
  if (arg === '--') {
    if (currentCommand.length > 0) {
      commands.push(currentCommand);
      currentCommand = [];
    }
  } else {
    currentCommand.push(arg);
  }
}
if (currentCommand.length > 0) {
  commands.push(currentCommand);
}

// Append YAML commands
commands.push(...yamlCommands);

if (commands.length === 0) {
  console.error('No commands provided');
  process.exit(1);
}

// Parse each command
const commandParseds = commands.map((cmdArgs) =>
  parseArgs({
    options: { ...commandOptions, ...globalOptions },
    allowPositionals: true,
    args: cmdArgs,
  })
);

debugLog({ globalValues, commandParseds });

async function getDeps(packages: string[], mode: 'upstream' | 'downstream') {
  if (!packages.length) return [];
  packages = packages.flatMap((p) => p.split(','));
  const args = packages.flatMap((pkg) => {
    const filter = mode === 'upstream' ? `${pkg}...` : mode === 'downstream' ? `...${pkg}` : pkg;
    return ['-F', filter];
  });
  const proc = logSpawn(['turbo', 'ls', '--output', 'json', ...args], { cwd: gitRoot });
  const output: { packages: { items: { path: string }[] } } = await new Response(
    proc.stdout
  ).json();
  return output.packages.items.map((p) => p.path);
}

function expandPattern(pattern: string) {
  return [changeCase.snakeCase(pattern), changeCase.camelCase(pattern)];
}

async function grepFor(
  patterns: string[],
  sourceFiles: string[],
  expand: boolean,
  wholeWord: boolean
): Promise<string[]> {
  if (!patterns.length) return [];
  patterns = patterns.flatMap((p) => p.split(','));
  if (expand) patterns = patterns.flatMap(expandPattern);
  const args = patterns.flatMap((p) => ['-e', p]);
  if (await Bun.file(path.join(baseDir, '.repomixignore')).exists()) {
    args.push(`--ignore-file=${path.join(baseDir, '.repomixignore')}`);
  }
  if (wholeWord) args.push('--word-regexp');

  const searchPaths = sourceFiles.length ? sourceFiles : [baseDir];
  const lowercase = args.every((a) => a.toLowerCase() === a);
  if (lowercase) {
    args.push('-i');
  }

  const proc = logSpawn(['rg', '--files-with-matches', ...args, ...searchPaths], {});
  const files = (await new Response(proc.stdout).text())
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => path.resolve(baseDir, file));
  return files;
}

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

async function getLargestNFiles(files: string[], n: number) {
  const filesWithSizes = await Promise.all(
    files.map(async (file) => ({
      file,
      size: await Bun.file(file)
        .stat()
        .then((d) => d.size)
        .catch(() => 0),
    }))
  );
  return filesWithSizes
    .sort((a, b) => b.size - a.size)
    .slice(0, n)
    .map((f) => f.file);
}

// Process each command
async function processCommand(
  cmdParsed: (typeof commandParseds)[number]
): Promise<{ filesSet: Set<string>; examples: { pattern: string; file: string }[] }> {
  const filesSet = new Set<string>();
  const allFoundExamples: { pattern: string; file: string }[] = [];
  const cmdValues = cmdParsed.values;
  const positionals = cmdParsed.positionals.flatMap((p) => p.split(','));

  if (positionals.length === 0 && !cmdValues.example?.length) {
    return { filesSet, examples: [] };
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
  let files = await glob(withDirGlobs, { cwd: baseDir, nodir: true });

  let exampleFiles: Promise<{ pattern: string; file: string }[]> | undefined;
  if (cmdValues.example?.length) {
    let values = cmdValues.example.flatMap((p) => p.split(','));
    exampleFiles = Promise.all(
      values.map(async (p) => {
        let matching = await grepFor([p], files, false, false);

        if (!matching.length) {
          throw new Error(`No files found matching example pattern: ${p}`);
        }

        let largest = await getLargestNFiles(matching, 1);
        return {
          pattern: p,
          file: largest[0],
        };
      })
    );
  }

  if (cmdValues.grep) {
    files = await grepFor(
      cmdValues.grep,
      files,
      cmdValues.expand ?? false,
      cmdValues['whole-word'] ?? false
    );
  }

  // Apply largest filter if specified
  if (cmdValues.largest) {
    const n = parseInt(cmdValues.largest, 10);
    if (isNaN(n) || n <= 0) {
      console.error(`Invalid value for --largest: ${cmdValues.largest}. Must be a positive number`);
      process.exit(1);
    }

    files = await getLargestNFiles(files, n);
  }

  let foundExamples = await (exampleFiles ?? []);
  if (foundExamples.length) {
    allFoundExamples.push(...foundExamples);

    if (cmdValues.grep) {
      // If we have other filters, then add the example files to the list of files
      files.push(...foundExamples.map((f) => f.file));
    } else {
      // Otherwise, just use the example files so we don't include everything
      files = foundExamples.map((f) => f.file);
    }
  }

  if (cmdValues['with-imports']) {
    files = await processWithImports(files, false);
  } else if (cmdValues['with-all-imports']) {
    files = await processWithImports(files, true);
  }

  files.forEach((file) => filesSet.add(file));

  return { filesSet, examples: allFoundExamples };
}

// Execute commands and combine results
const allFilesSet = new Set<string>();
const allFileDirs = new Set<string>();
const allExamples: { pattern: string; file: string }[] = [];
await Promise.all(
  commandParseds.map(async (cmdParsed) => {
    const cmdFiles = await processCommand(cmdParsed);
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
    let pkg = await resolver.resolvePackageJson(d);
    if (pkg?.path) {
      allFilesSet.add(path.join(pkg.path, 'package.json'));
    }
  })
);

// Handle output
const outputFile = globalValues.output ?? (await getOutputPath());
const editFormat = globalValues['edit-format'] || 'whole-file';

const longestPatternLen = allExamples.reduce((a, b) => Math.max(a, b.pattern.length), 0);

const [
  examplesTag,
  { diffTag, changedFiles },
  { docsTag, instructionsTag, rulesTag, rawInstructions },
] = await Promise.all([
  buildExamplesTag(allExamples),
  getDiffTag(gitRoot, globalValues),
  getAdditionalDocs(baseDir, {
    ...globalValues,
    instructions: (globalValues.instructions || []).concat(editorInstructions),
  }),
]);

for (let file of changedFiles) {
  allFilesSet.add(path.resolve(gitRoot, file));
}

const allPaths = Array.from(allFilesSet, (p) => path.relative(gitRoot, p));

// Call repomix
const repomixOutput = allPaths.length
  ? await callRepomix(gitRoot, rawInstructions, [
      '--top-files-len',
      '20',
      '--include',
      allPaths.join(','),
    ])
  : '';

const guidelinesTag = `<guidelines>
<guideline>When making a change, update related tests.</guideline>
<guideline>Leave existing comments and docstrings alone unless updating them is relevant to the change.</guideline>
<guideline>It is ok for existing comments to seem redundant or obvious, as long as they are correct.</guideline>
</guidelines>`;

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
  editFormat === 'whole-xml' && notBare ? xmlFormatPrompt : '',
  editFormat === 'diff' && notBare ? generateSearchReplacePrompt : '',
  editFormat === 'whole-file' && notBare ? generateWholeFilePrompt : '',
  notBare ? guidelinesTag : '',
  instructionsTag,
]
  .filter(Boolean)
  .join('\n\n');

await Bun.write(outputFile, finalOutput);

if (!globalValues.quiet) {
  if (allExamples.length) {
    console.log('\n## EXAMPLES');
    for (let { pattern, file } of allExamples) {
      console.log(`${(pattern + ':').padEnd(longestPatternLen + 1)} ${file}`);
    }
  }

  if (rawInstructions) {
    console.log('\n## INSTRUCTIONS');
    console.log(rawInstructions);
  }

  const tokens = encode(finalOutput);
  console.log('\n## OUTPUT');
  console.log(`Tokens: ${tokens.length}`);
  console.log(`Output written to ${outputFile}, edit format: ${editFormat}`);
}

if (globalValues.copy) {
  await copyToClipboard(finalOutput);
}

async function copyToClipboard(text: string) {
  const command =
    process.platform === 'darwin'
      ? ['pbcopy']
      : process.platform === 'win32'
        ? ['clip']
        : ['xclip', '-selection', 'clipboard'];
  const proc = logSpawn(command, {
    stdin: 'pipe',
    stdout: globalValues.quiet ? 'ignore' : 'inherit',
    stderr: globalValues.quiet ? 'ignore' : 'inherit',
  });
  proc.stdin.write(text);
  await proc.stdin.end();
  const exitCode = await proc.exited;
  if (!globalValues.quiet) {
    console.log(
      exitCode === 0
        ? 'Output copied to clipboard'
        : `Failed to copy to clipboard (exit code: ${exitCode})`
    );
  }
}
