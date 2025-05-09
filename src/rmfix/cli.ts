#!/usr/bin/env bun
import { program } from 'commander';
import { runRmfix } from './rmfix';
import type { RmfixCoreOptions, RmfixCliOptions } from './types';
import { setDebug, setQuiet } from '../rmfilter/utils';

program
  .name('rmfix')
  .description(
    'Run a command, capture its output, and if it fails, use rmfilter to help fix the issue.'
  )
  .option('--debug', 'Enable debug logging for rmfix itself')
  .option('--quiet', 'Suppress rmfix informational logging (not the command output)')
  .option('--format <type>', 'Specify output format (json, tap, text, auto)', 'auto')
  .arguments('<command_with_args...>')
  .action(async (commandWithArgs: string[]) => {
    const rmfixOwnOptions = program.opts();
    let commandToRunAndItsArgs: string[];
    let rmfilterArgs: string[] = [];

    const separatorIndex = commandWithArgs.findIndex((arg) => arg === '--' || arg === '///');

    if (separatorIndex === -1) {
      commandToRunAndItsArgs = commandWithArgs;
    } else {
      commandToRunAndItsArgs = commandWithArgs.slice(0, separatorIndex);
      rmfilterArgs = commandWithArgs.slice(separatorIndex + 1);
    }

    if (commandToRunAndItsArgs.length === 0) {
      console.error('rmfix: error: missing command to run. Please specify a command.');
      // program.help({ error: true }); // This exits the process
      // For more control or custom message before help:
      program.outputHelp();
      process.exit(1);
      return;
    }

    const command = commandToRunAndItsArgs[0];
    const commandArgs = commandToRunAndItsArgs.slice(1);

    const cliOptions: RmfixCliOptions = {
      debug: rmfixOwnOptions.debug,
      quiet: rmfixOwnOptions.quiet,
      format: rmfixOwnOptions.format,
    };

    setDebug(cliOptions.debug);
    setQuiet(cliOptions.quiet);

    const options: RmfixCoreOptions = {
      command,
      commandArgs,
      rmfilterArgs,
      cliOptions,
    };

    try {
      const exitCode = await runRmfix(options);
      process.exit(exitCode);
    } catch (error) {
      console.error('An unexpected error occurred in rmfix:');
      if (error instanceof Error) {
        console.error(error.message);
        if (error.stack) console.error(error.stack);
      } else {
        console.error(String(error));
      }
      process.exit(1);
    }
  });

program.parse(process.argv);
