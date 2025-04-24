#!/usr/bin/env bun
import { planSchema } from './planSchema.js';
import { planPrompt } from './prompt.js';
import { Command } from 'commander';

const program = new Command();
program
  .name('rmplan')
  .description('Generate and execute task plans using LLMs');

program
  .command('generate')
  .description('Generate planning prompt and context for a task')
  .option('--plan <file>', 'YAML plan file to use')
  .option('--plan-editor', 'Open plan in editor')
  .allowUnknownOption(true)
  .action((options, command) => {
    // Find '--' in process.argv to get extra args for rmfilter
    const doubleDashIdx = process.argv.indexOf('--');
    const rmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];

    // Manual conflict check for --plan and --plan-editor
    if ((options.plan && options.planEditor) || (!options.plan && !options.planEditor)) {
      console.error('You must provide either --plan <file> or --plan-editor (but not both).');
      process.exit(1);
    }

    // TODO: Pass rmfilterArgs to rmfilter logic
    console.log('generate...');
    console.log('Options:', options);
    console.log('rmfilter args:', rmfilterArgs);
  });

program
  .command('extract')
  .description('Extract and validate a plan YAML from text')
  .action(() => {
    console.log('extract...');
  });

program
  .command('done')
  .description('Mark the next step/task in a plan YAML as done')
  .action(() => {
    console.log('done...');
  });

program
  .command('next')
  .description('Prepare the next step(s) from a plan YAML for execution')
  .action(() => {
    console.log('next...');
  });

program.parse(process.argv);
