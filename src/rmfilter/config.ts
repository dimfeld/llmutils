import { glob } from 'glob';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { debugLog, error, log } from '../logging.ts';
import { getGitRoot } from './utils.ts';

export interface ModelPreset {
  noArtifacts?: boolean;
  defaultEditFormat?: 'diff';
  overeager?: boolean;
}

export const modelPresets = {
  gemini: {
    overeager: true,
  },
  grok: {
    noArtifacts: true,
    defaultEditFormat: 'diff',
  },
  claude: {
    defaultEditFormat: 'diff',
    overeager: true,
  },
} satisfies Record<string, ModelPreset>;

export function resolveModelSettings(model: string | undefined): ModelPreset {
  const defaultModelSettings: ModelPreset = { overeager: true };
  if (!model) {
    return defaultModelSettings;
  }

  if (model.startsWith('google/gemini')) {
    model = 'gemini';
  } else if (model.startsWith('anthropic/') || model.startsWith('claude')) {
    model = 'claude';
  }

  return modelPresets[model as keyof typeof modelPresets] || defaultModelSettings;
}

// Zod schemas for YAML validation
// Put this comment at the top of your YAML file to reference the schema:
// # yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmfilter-config-schema.json
export const CommandConfigSchema = z
  .object({
    base: z.string().optional().describe('Base directory for globs for this command'),
    globs: z.string().array().optional(),
    grep: z.union([z.string(), z.string().array()]).optional(),
    ignore: z.string().array().optional(),
    'whole-word': z.boolean().optional(),
    expand: z.boolean().optional(),
    'no-expand-pages': z.boolean().optional(),
    'with-imports': z.boolean().optional(),
    'with-all-imports': z.boolean().optional(),
    'changed-files': z.boolean().optional(),
    upstream: z.union([z.string(), z.string().array()]).optional(),
    downstream: z.union([z.string(), z.string().array()]).optional(),
    largest: z.string().optional(),
    example: z.union([z.string(), z.string().array()]).optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    description: z.string().optional(),
    'edit-format': z
      .enum(['whole-xml', 'diff', 'diff-orig', 'diff-fenced', 'udiff-simple', 'whole', 'none'])
      .optional(),
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
    'no-autodocs': z
      .boolean()
      .optional()
      .describe('Disable automatic loading of .mdc rule/doc files'),
    'diff-from': z.string().optional(),
    'instructions-editor': z.boolean().optional(),
    bare: z.boolean().optional(),
    compress: z.boolean().optional(),
    commands: CommandConfigSchema.array().optional(),
  })
  .strict();

// Function to search for preset YAML file
export async function findPresetFile(preset: string, gitRoot: string): Promise<string | null> {
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
): Promise<{ name: string; description: string | undefined; source: 'repository' | 'global' }[]> {
  let currentDir = process.cwd();
  const gitRootDir = path.resolve(gitRoot);
  const homeConfigDir = path.join(os.homedir(), '.config', 'rmfilter');

  const projectSearchDirs: string[] = [];
  // Collect directories from current path up to git root
  const components = currentDir.split(path.sep);
  while (currentDir.startsWith(gitRootDir)) {
    projectSearchDirs.push(path.join(components.join(path.sep), '.rmfilter'));
    components.pop();
    const parentDir = components.join(path.sep);
    currentDir = parentDir;
  }

  const presetInfo = new Map<string, { path: string; source: 'repository' | 'global' }>();

  // Search project directories first to prioritize them
  for (const dir of projectSearchDirs) {
    try {
      const files = await glob('*.yml', { cwd: dir, absolute: true });
      files.forEach((file) => {
        const presetName = path.basename(file, '.yml');
        // Set (or overwrite) - implicitly prioritizes presets closer to cwd if names clash within repo
        presetInfo.set(presetName, { path: file, source: 'repository' });
      });
    } catch (e) {
      // Ignore errors like directory not found
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        debugLog(`Error searching directory ${dir}: ${(e as Error).message}`);
      }
    }
  }

  // Search global config directory
  try {
    const globalFiles = await glob('*.yml', { cwd: homeConfigDir, absolute: true });
    globalFiles.forEach((file) => {
      const presetName = path.basename(file, '.yml');
      if (!presetInfo.has(presetName)) {
        // Only add if not found in the repository
        presetInfo.set(presetName, { path: file, source: 'global' });
      }
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugLog(`Error searching directory ${homeConfigDir}: ${(e as Error).message}`);
    }
  }

  const items = await Promise.all(
    Array.from(presetInfo.entries()).map(async ([presetName, info]) => {
      const path = info.path;
      const data = await Bun.file(path).text();
      let description: string | undefined;
      try {
        const parsedConfig = parse(data);
        const config = ConfigSchema.safeParse(parsedConfig);
        if (config.success) {
          description = config.data.description;
        } else {
          debugLog(
            `Could not parse description from preset ${presetName} at ${path}: ${config.error.message}`
          );
        }
      } catch (parseError) {
        debugLog(`Error parsing preset file ${path}: ${(parseError as Error).message}`);
      }
      return { ...info, name: presetName, description };
    })
  );

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCurrentConfig() {
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
    'no-autodocs': { type: 'boolean' },
    'diff-from': { type: 'string' },
    'instructions-editor': { type: 'boolean' },
    'omit-instructions-tag': { type: 'boolean' },
    bare: { type: 'boolean' },
    config: { type: 'string' },
    preset: { type: 'string' },
    quiet: { type: 'boolean', short: 'q' },
    'list-presets': { type: 'boolean' },
    new: { type: 'string' },
    compress: { type: 'boolean' },
    model: { type: 'string', short: 'm' },
  } as const;

  // Define command-specific options
  const commandOptions = {
    base: { type: 'string' },
    grep: { type: 'string', short: 'g', multiple: true },
    ignore: { type: 'string', multiple: true },
    'changed-files': { type: 'boolean' },
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
  const gitRoot = await getGitRoot();

  // Load YAML config if provided
  let yamlCommands: string[][] = [];
  let yamlConfigPath: string | undefined;
  if (globalValues.preset || globalValues.config) {
    try {
      if (globalValues.preset) {
        const presetPath = await findPresetFile(globalValues.preset, gitRoot);
        if (!presetPath) {
          error(
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

            if (cmd.ignore) {
              for (const ignore of cmd.ignore) {
                args.push(`--ignore`, ignore);
              }
            }

            for (const [key, value] of Object.entries(cmd)) {
              if (key === 'globs' || key === 'ignore') continue;
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
    } catch (e) {
      error(`Failed to load YAML config: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // Handle help message
  if (globalValues.help) {
    log(`usage: rmfilter [global options] [files/globs [command options]] [-- [files/globs [command options]]] ...

Commands:
  --list-presets            List available presets and exit
  --new <file>              Create a new YAML config file at the specified path

Global Options:
  --config <file>           Load configuration from YAML file
  --preset <name>           Load preset YAML config from .rmfilter/<name>.yml or $HOME/.config/rmfilter/<name>.yml
  --edit-format <format>    Set edit format (whole-xml, diff, whole) or "none" to omit
  -o, --output <file>       Specify output file
  -c, --copy                Copy output to clipboard
  --cwd <dir>               Set working directory
  --gitroot                 Use Git root as working directory
  --bare                    Omit all extra rules and formatting instructions
  -h, --help                Show this help message
  --debug                   Print executed commands
  -q, --quiet               Suppress all output from tool and spawned processes
  --with-diff               Include Git diff against main/master in output
  --diff-from (<branch>|<rev>) Diff from <branch> instead of main
  -i, --instructions <text> Add instructions (prefix @ for files)
  --docs <globs>            Add documentation files
  --rules <globs>           Add rules files
  --omit-cursorrules        Skip loading .cursorrules
  --no-autodocs             Disable automatic loading of .mdc rule/doc files
  --instructions-editor     Open editor for instructions in $EDITOR
  -m, --model <grok|gemini> Set presets for certain models

Command Options (per command):
  -g, --grep <patterns>     Include files matching these patterns
  -w, --whole-word          Match whole words in grep
  -e, --expand              Expand grep patterns (snake_case, camelCase)
  --ignore <patterns>       Ignore files matching these patterns
  --changed-files           Include all changed files
  --no-expand-pages         Disable inclusion of matching page/server route files
  --with-imports            Include direct imports of files
  --with-all-imports        Include entire import tree
  --upstream <pkgs>         Include upstream dependencies
  --downstream <pkgs>       Include downstream dependents
  -l, --largest <number>    Keep only the N largest files
  --example <pattern>       Include the largest file that matches the pattern.
`);

    process.exit(0);
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

  // Parse each command
  const commandsParsed = commands.map((cmdArgs) =>
    parseArgs({
      options: { ...commandOptions, ...globalOptions },
      allowPositionals: true,
      args: cmdArgs,
    })
  );

  return {
    globalValues,
    yamlConfigPath,
    yamlCommands,
    commandsParsed,
  };
}

export async function writeSampleConfig(yamlPath: string) {
  const defaultConfig: z.infer<typeof ConfigSchema> = {
    description: 'New rmfilter configuration',
    'edit-format': 'diff',
    copy: true,
    quiet: false,
    docs: [],
    rules: [],
    commands: [
      {
        globs: ['src/**/*'],
        grep: [],
        'whole-word': false,
        expand: false,
      },
    ],
    instructions: 'instructions\ngo here',
  };

  if (!yamlPath.endsWith('.yml') && !yamlPath.endsWith('.yaml')) {
    yamlPath += '.yml';
  }

  try {
    await Bun.file(yamlPath).stat();
    error(`File already exists at ${yamlPath}`);
    process.exit(1);
  } catch {
    // File doesn't exist, proceed with creation
    const configContents = stringify(defaultConfig, { indentSeq: false });
    const yamlContent =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmfilter-config-schema.json\n' +
      configContents;
    await Bun.write(yamlPath, yamlContent);
  }
}

export async function listPresets() {
  const gitRoot = await getGitRoot();
  const presets = await findAllPresetFiles(gitRoot);
  if (presets.length > 0) {
    log('Available presets:');
    const longestNameLength = presets.reduce((max, p) => Math.max(max, p.name.length), 0);
    const sourcePadding = '(repository)'.length; // Length of the longest source string + ()

    presets.forEach((preset) => {
      const sourceStr = `(${preset.source})`;
      const descriptionStr = preset.description ? ` ${preset.description}` : '';
      log(
        `${preset.name.padEnd(longestNameLength)}   ${sourceStr.padEnd(sourcePadding)} ${descriptionStr}`
      );
    });
  } else {
    log('No presets found.');
  }
}
