// Command handler for 'rmplan init'
// Sets up a repository with a sample rmplan configuration file

import * as fs from 'node:fs/promises';
import * as path from 'path';
import { confirm, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import yaml from 'yaml';
import { log } from '../../logging.js';
import { getGitRoot } from '../../common/git.js';
import { DEFAULT_EXECUTOR } from '../constants.js';
import type { RmplanConfigInput } from '../configSchema.js';

interface InitOptions {
  force?: boolean;
  minimal?: boolean;
  yes?: boolean;
}

export async function handleInitCommand(options: InitOptions, command: any) {
  try {
    // Get git root or use current directory
    const gitRoot = (await getGitRoot()) || process.cwd();
    const configDir = path.join(gitRoot, '.rmfilter', 'config');
    const configPath = path.join(configDir, 'rmplan.yml');

    // Check if config already exists
    const configExists = await fs
      .access(configPath)
      .then(() => true)
      .catch(() => false);

    if (configExists && !options.force) {
      log(chalk.yellow('⚠ Configuration file already exists:'), configPath);
      const shouldOverwrite = options.yes
        ? true
        : await confirm({
            message: 'Do you want to overwrite it?',
            default: false,
          });

      if (!shouldOverwrite) {
        log(chalk.gray('Initialization cancelled.'));
        return;
      }
    }

    // Gather configuration preferences
    let config: RmplanConfigInput;

    if (options.minimal) {
      // Minimal configuration with just defaults
      config = {
        paths: {
          tasks: 'tasks',
        },
        defaultExecutor: DEFAULT_EXECUTOR,
      };
      log(chalk.blue('Creating minimal configuration...'));
    } else if (options.yes) {
      // Use all defaults without prompting
      config = createDefaultConfig();
      log(chalk.blue('Creating default configuration...'));
    } else {
      // Interactive mode - ask user for preferences
      config = await promptForConfig();
    }

    // Create directory structure
    await fs.mkdir(configDir, { recursive: true });

    // Write configuration file
    const configContent = yaml.stringify(config, {
      lineWidth: 0, // Disable line wrapping
      defaultStringType: 'PLAIN',
    });

    // Add YAML language server comment at the top
    const configWithSchema =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-config-schema.json\n\n' +
      configContent;

    await fs.writeFile(configPath, configWithSchema, 'utf-8');
    log(chalk.green('✓ Created configuration file:'), configPath);

    // Create tasks directory if specified
    const tasksPath = config.paths?.tasks;
    if (tasksPath) {
      const resolvedTasksPath = path.isAbsolute(tasksPath)
        ? tasksPath
        : path.join(gitRoot, tasksPath);
      await fs.mkdir(resolvedTasksPath, { recursive: true });
      log(chalk.green('✓ Created tasks directory:'), resolvedTasksPath);
    }

    // Update .gitignore
    await updateGitignore(gitRoot);

    // Show success message with next steps
    log(chalk.green('\n✓ Initialization complete!'));
    log(chalk.gray('\nNext steps:'));
    log(chalk.gray('  1. Review and customize the configuration file:'));
    log(chalk.gray(`     ${configPath}`));
    log(chalk.gray('  2. Create your first plan:'));
    log(chalk.gray('     rmplan add "Your plan title"'));
    log(chalk.gray('  3. Learn more about rmplan commands:'));
    log(chalk.gray('     rmplan --help'));
  } catch (err) {
    log(chalk.red('✗ Initialization failed:'), (err as Error).message);
    throw err;
  }
}

/**
 * Updates or creates .gitignore with required rmplan entries
 */
async function updateGitignore(gitRoot: string): Promise<void> {
  const gitignorePath = path.join(gitRoot, '.gitignore');
  const requiredEntries = ['.rmfilter/reviews', '.rmfilter/config/rmplan.local.yml'];

  let gitignoreContent = '';
  let exists = false;

  try {
    gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
    exists = true;
  } catch (err) {
    // File doesn't exist, will create it
  }

  const lines = gitignoreContent.split('\n');
  const existingEntries = new Set(lines.map((line) => line.trim()));
  const entriesToAdd = requiredEntries.filter((entry) => !existingEntries.has(entry));

  if (entriesToAdd.length === 0 && exists) {
    log(chalk.green('✓ .gitignore already contains required entries'));
    return;
  }

  // Add entries with a comment
  const newContent = gitignoreContent ? gitignoreContent.trimEnd() + '\n\n' : '';
  const updatedContent =
    newContent +
    '# rmplan generated files\n' +
    entriesToAdd.join('\n') +
    (entriesToAdd.length > 0 ? '\n' : '');

  await fs.writeFile(gitignorePath, updatedContent, 'utf-8');

  if (exists) {
    log(chalk.green('✓ Updated .gitignore with rmplan entries'));
  } else {
    log(chalk.green('✓ Created .gitignore with rmplan entries'));
  }
}

/**
 * Creates a default configuration object with common settings
 */
function createDefaultConfig(): RmplanConfigInput {
  return {
    paths: {
      tasks: 'tasks',
    },
    defaultExecutor: DEFAULT_EXECUTOR,
    postApplyCommands: [
      {
        title: 'Format code',
        command: 'bun run format',
        allowFailure: true,
        hideOutputOnSuccess: true,
      },
    ],
    prCreation: {
      draft: true,
    },
    updateDocs: {
      mode: 'after-iteration',
    },
    executors: {
      'claude-code': {
        permissionsMcp: {
          enabled: true,
          autoApproveCreatedFileDeletion: true,
        },
      },
    },
  };
}

/**
 * Prompts the user for configuration preferences interactively
 */
async function promptForConfig(): Promise<RmplanConfigInput> {
  log(chalk.blue('Setting up rmplan configuration...\n'));

  // Ask for tasks directory
  const tasksDir = await input({
    message: 'Where should plan files be stored?',
    default: 'tasks',
    validate: (value: string) => {
      if (!value || value.trim() === '') {
        return 'Please provide a directory path';
      }
      return true;
    },
  });

  // Ask for default executor
  const executor = await select({
    message: 'Which executor should be used by default?',
    choices: [
      {
        name: 'claude-code - Claude Code',
        value: 'claude-code',
        description: 'Recommended if you use Claude Code',
      },
      {
        name: 'codex-cli - OpenAI Codex',
        value: 'codex-cli',
        description: 'Recommended if you use OpenAI Codex',
      },
    ],
    default: DEFAULT_EXECUTOR,
  });

  // Ask about post-apply commands
  const includePostApply = await confirm({
    message: 'Add a code formatting command to run after changes?',
    default: true,
  });

  const config: RmplanConfigInput = {
    paths: {
      tasks: tasksDir,
    },
    defaultExecutor: executor,
  };

  if (includePostApply) {
    const formatCommand = await input({
      message: 'What command should be used for formatting?',
      default: 'npm run format',
    });

    config.postApplyCommands = [
      {
        title: 'Format code',
        command: formatCommand,
        allowFailure: true,
        hideOutputOnSuccess: true,
      },
    ];
  }

  // Ask about PR creation settings
  const draftPRs = await confirm({
    message: 'Create pull requests as drafts by default?',
    default: true,
  });

  config.prCreation = {
    draft: draftPRs,
  };

  return config;
}
