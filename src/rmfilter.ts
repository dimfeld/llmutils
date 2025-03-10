#!/usr/bin/env bun
import { $, type SpawnOptions, type Subprocess } from 'bun';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packageUp } from 'package-up';
import { parseArgs } from 'util';
import * as changeCase from 'change-case';
import os from 'node:os';
import { glob, globSync } from 'glob';
import { xmlFormatPrompt } from './xml/prompt';
import { generateSearchReplacePrompt } from './diff-editor/prompts';

let { values, positionals } = parseArgs({
  options: {
    include: {
      type: 'string',
      short: 'i',
      multiple: true,
    },
    'edit-format': {
      type: 'string',
      short: 'f',
    },
    packages: {
      type: 'string',
      multiple: true,
      short: 'p',
    },
    upstream: {
      type: 'string',
      multiple: true,
      short: 'u',
    },
    downstream: {
      type: 'string',
      short: 'd',
      multiple: true,
    },
    both: {
      type: 'string',
      short: 'b',
      multiple: true,
    },
    path: {
      type: 'string',
      multiple: true,
    },
    grep: {
      type: 'string',
      short: 'g',
      multiple: true,
    },
    'grep-in': {
      type: 'string',
      multiple: true,
    },
    'grep-package': {
      type: 'string',
      short: 'G',
      multiple: true,
    },
    'whole-word': {
      type: 'boolean',
      short: 'w',
    },
    instructions: {
      type: 'string',
      multiple: true,
    },
    docs: {
      type: 'string',
      multiple: true,
    },
    rules: {
      type: 'string',
      short: 'r',
      multiple: true,
    },
    expand: {
      type: 'boolean',
      short: 'e',
    },
    architect: {
      type: 'boolean',
      short: 'a',
    },
    output: {
      type: 'string',
      short: 'o',
    },
    copy: {
      type: 'boolean',
      short: 'c',
    },
    cwd: {
      type: 'string',
    },
    help: {
      type: 'boolean',
      short: 'h',
    },
    debug: {
      type: 'boolean',
    },
  },
  allowPositionals: true,
  allowNegative: true,
});

// Helper function to log and execute commands
function logSpawn<
  T extends SpawnOptions.OptionsObject<
    SpawnOptions.Writable,
    SpawnOptions.Readable,
    SpawnOptions.Readable
  >,
>(cmd: string[], options?: T) {
  if (values.debug) {
    console.log(`[DEBUG] Executing: ${cmd.join(' ')}`);
    if (options?.cwd) {
      console.log(`[DEBUG] cwd: ${options.cwd}`);
    }
  }
  return Bun.spawn(cmd, options);
}

// Update help message
if (values.help) {
  console.log('usage: rmfilter <packages>');
  console.log();
  console.log('Options:');
  console.log('  --cwd <dir>                 Set the working directory, defaults to git root');
  console.log('  -f, --edit-format (xml|diff)  Set the edit format');
  console.log('  -p, --packages <packages>   Include the contents of these packages');
  console.log('  -u, --upstream <packages>   Include this packages and its dependencies');
  console.log('  -d, --downstream <packages> Include this package and its dependents');
  console.log(
    '  -b, --both <packages>       Include the package and its upstream and downstream dependencies'
  );
  console.log('  -g, --grep <patterns>       Include files that match this pattern');
  console.log(
    '  --grep-in <base_dirs>:<patterns>  Include files that match these patterns in specified directories'
  );
  console.log(
    '  -G, --grep-package <pkg>    Include all packages with a file whose contents matches ths pattern'
  );
  console.log(
    '  -e, --expand                Expand search terms to include snake case, camel case, etc.'
  );
  console.log('  -w, --whole-word            Match whole words only');
  console.log('  -a, --architect             Enable architect mode (removes empty lines)');
  console.log(
    '  -i, --instructions          Add instructions to the prompt, prefix with @ to indicate a file.'
  );
  console.log('  -r, --rules <rules>         Add rules files to the prompt');
  console.log('  -d, --docs <docs>           Add docs files to the prompt');
  console.log('  -o, --output <file>         Specify the output file');
  console.log('  -c, --copy                  Copy the output file to the clipboard');
  console.log('  -h, --help                  Show this help message and exit');
  console.log('  -D, --debug                 Print all executed commands');
  process.exit(0);
}

if (values['edit-format'] && !['whole-xml', 'diff', 'whole'].includes(values['edit-format'])) {
  console.error(
    `Invalid edit format: ${values['edit-format']}. Must be 'whole-xml', 'diff', or 'whole`
  );
  process.exit(1);
}

let rootDir = values.cwd || (await $`git rev-parse --show-toplevel`.nothrow().text()).trim();
rootDir = rootDir ? path.resolve(rootDir) : process.cwd();

async function getDeps(packages: string[] | undefined, mode: 'upstream' | 'downstream' | 'only') {
  if (!packages?.length) {
    return [];
  }

  packages = packages.flatMap((p) => p.split(','));

  let args = packages.flatMap((pkg) => {
    let filter: string;
    if (mode === 'upstream') {
      filter = `${pkg}...`;
    } else if (mode === 'downstream') {
      filter = `...${pkg}`;
    } else {
      filter = pkg;
    }
    return ['-F', filter];
  });

  let proc = logSpawn(['turbo', 'ls', '--output', 'json', ...args], { cwd: rootDir });
  let output: { packages: { items: { path: string }[] } } = await new Response(proc.stdout).json();

  return output.packages.items.map((p) => p.path);
}

function expandPattern(pattern: string) {
  return [changeCase.snakeCase(pattern), changeCase.camelCase(pattern)];
}

let repomixIgnoreExistsPromise: Promise<boolean> | undefined;
async function useRepomixIgnore() {
  repomixIgnoreExistsPromise ??= Bun.file(path.join(rootDir, '.repomixignore')).exists();
  return repomixIgnoreExistsPromise;
}

async function grepFor(
  patterns: string[] | undefined,
  mode: 'file' | 'package',
  baseDirs?: string[]
): Promise<string[]> {
  if (!patterns?.length) {
    return [];
  }

  patterns = patterns.flatMap((p) => p.split(','));

  if (values.expand) {
    patterns = patterns.flatMap(expandPattern);
  }

  let args = patterns.flatMap((pattern) => ['-e', pattern]);
  if (await useRepomixIgnore()) {
    const ignorePath = path.join(rootDir, '.repomixignore');
    args.push(`--ignore-file=${ignorePath}`);
  }

  if (values['whole-word']) {
    args.push('--word-regexp');
  }

  const searchDirs = baseDirs?.length
    ? baseDirs.map((dir) => path.resolve(rootDir, dir))
    : [rootDir];

  const resultsPromises = searchDirs.map(async (dir) => {
    let proc = logSpawn(['rg', '-i', '--files-with-matches', ...args, dir], {});
    return await new Response(proc.stdout).text();
  });

  const results = await Promise.all(resultsPromises);

  let files = results
    .flatMap((result) => result.split('\n'))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => path.relative(rootDir, path.resolve(file)));

  if (mode === 'file') {
    return files;
  }

  let packagePaths = await Promise.all(
    files.map((file) =>
      packageUp({
        cwd: path.dirname(path.resolve(rootDir, file)),
      })
    )
  );

  let packageDirs = new Set(
    packagePaths
      .map((p) => {
        if (!p) {
          return;
        }

        let dir = path.dirname(p);
        let relDir = path.relative(rootDir, dir);
        if (relDir === '') {
          return;
        }

        return relDir;
      })
      .filter((p) => p != null)
  );

  return [...packageDirs];
}

async function processGrepIn(grepInArgs: string[] | undefined): Promise<string[]> {
  if (!grepInArgs?.length) {
    return [];
  }

  const grepCalls = grepInArgs
    .map((arg) => {
      const [dirsStr, patternsStr] = arg.split(':');
      if (!dirsStr || !patternsStr) {
        console.error(`Invalid --grep-in format: ${arg}. Expected format: <dirs>:<patterns>`);
        return null;
      }

      const dirs = dirsStr.split(',');
      const patterns = patternsStr.split(',');

      return { dirs, patterns };
    })
    .filter((call) => call !== null);

  const results = await Promise.all(
    grepCalls.map(({ dirs, patterns }) => grepFor(patterns, 'file', dirs))
  );

  return results.flat();
}

let upstream = [...(values.upstream ?? []), ...(values.both ?? [])];
let downstream = [...(values.downstream ?? []), ...(values.both ?? [])];

let pathsSet = new Set(
  (
    await Promise.all([
      getDeps(upstream, 'upstream'),
      getDeps(downstream, 'downstream'),
      getDeps(values.packages, 'only'),
      grepFor(values.grep, 'file'),
      grepFor(values['grep-package'], 'package'),
      processGrepIn(values['grep-in']),
      ...(values.include ?? []),
    ])
  )
    .flat()
    .concat(values.path ?? [])
);

let allPaths = Array.from(pathsSet).join(',');

const architectArgs = values.architect ? ['--remove-empty-lines'] : [];

const tempFile = path.join(tmpdir(), `repomix-${Math.random().toString(36).slice(2)}.txt`);
let proc = logSpawn(
  [
    'repomix',
    '--ignore',
    '*.sql',
    '--include',
    allPaths,
    ...architectArgs,
    ...positionals,
    '-o',
    tempFile,
  ],
  {
    cwd: rootDir,
    stdout: 'inherit',
    stderr: 'inherit',
  }
);
const exitCode = await proc.exited;
if (exitCode !== 0) {
  console.error(`repomix exited with code ${exitCode}`);
  process.exit(exitCode);
}

const repomixOutput = await Bun.file(tempFile).text();
await Bun.file(tempFile).unlink();

let instructionsTag = '';
if (values.instructions) {
  let instructionsContent: string[] = [];

  for (let instruction of values.instructions) {
    if (instruction.startsWith('@')) {
      const pattern = instruction.slice(1);
      const matches = await glob(pattern);
      if (matches.length === 0) {
        console.error(`No files found matching pattern: ${pattern}`);
        process.exit(1);
      }
      for (const file of matches) {
        try {
          instructionsContent.push(await Bun.file(file).text());
        } catch (error) {
          console.error(`Error reading instructions file: ${file}`);
          process.exit(1);
        }
      }
    } else {
      instructionsContent.push(instruction);
    }
  }

  let output = instructionsContent.map((s) => s.trim()).join('\n\n');
  instructionsTag = `<instructions>\n${output}\n</instructions>`;
}

let docsTag = '';
if (values.docs) {
  let docsContent: string[] = [];

  for (let pattern of values.docs) {
    const matches = await glob(pattern);
    if (matches.length === 0) {
      console.error(`No files found matching pattern: ${pattern}`);
      process.exit(1);
    }
    for (const file of matches) {
      try {
        docsContent.push(await Bun.file(file).text());
      } catch (error) {
        console.error(`Error reading docs file: ${file}`);
        process.exit(1);
      }
    }
  }

  let output = docsContent.map((s) => s.trim()).join('\n\n');
  docsTag = `<docs>\n${output}\n</docs>`;
}

let rulesTag = '';
if (values.rules) {
  let rulesContent: string[] = [];

  for (let pattern of values.rules) {
    const matches = await glob(pattern);
    if (matches.length === 0) {
      console.error(`No files found matching pattern: ${pattern}`);
      process.exit(1);
    }
    for (const file of matches) {
      try {
        rulesContent.push(await Bun.file(file).text());
      } catch (error) {
        console.error(`Error reading rules file: ${file}`);
        process.exit(1);
      }
    }
  }

  let output = rulesContent.map((s) => s.trim()).join('\n\n');
  rulesTag = `<rules>\n${output}\n</rules>`;
}

async function copyToClipboard(text: string) {
  let command: string[];
  if (process.platform === 'darwin') {
    command = ['pbcopy'];
  } else if (process.platform === 'win32') {
    command = ['clip'];
  } else {
    const hasWlCopy = await $`command -v wl-copy`
      .quiet()
      .then(() => true)
      .catch(() => false);
    if (hasWlCopy) {
      command = ['wl-copy'];
    } else {
      const hasXclip = await $`command -v xclip`
        .quiet()
        .then(() => true)
        .catch(() => false);
      if (hasXclip) {
        command = ['xclip', '-selection', 'clipboard'];
      } else {
        console.warn('No clipboard utility found (install wl-copy or xclip on Linux)');
        return;
      }
    }
  }
  const proc = logSpawn(command, {
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  proc.stdin.write(text);
  await proc.stdin.end();
  const exitCode = await proc.exited;
  if (exitCode === 0) {
    console.log('Output copied to clipboard');
  } else {
    console.warn(`Failed to copy to clipboard (exit code: ${exitCode})`);
  }
}

let outputFile;
if (values.output) {
  outputFile = values.output;
} else {
  const configPath = path.join(os.homedir(), '.config', 'repomix', 'repomix.config.json');
  if (await Bun.file(configPath).exists()) {
    try {
      const config = await Bun.file(configPath).json();
      outputFile = config.output?.filePath;
    } catch (error) {
      console.error(`Error reading config file: ${configPath}`);
    }
  }
  if (!outputFile) {
    outputFile = './repomix_output.txt';
  }
}

const finalOutput = [
  repomixOutput,
  docsTag,
  rulesTag,
  values['edit-format'] === 'whole-xml' ? xmlFormatPrompt : '',
  values['edit-format'] === 'diff' ? generateSearchReplacePrompt : '',
  instructionsTag,
]
  .filter(Boolean)
  .join('\n\n');
await Bun.write(outputFile, finalOutput);
console.log(`Output written to ${outputFile}`);

if (values.copy) {
  await copyToClipboard(finalOutput);
}
