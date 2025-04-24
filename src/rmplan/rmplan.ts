#!/usr/bin/env bun
import { planSchema } from './planSchema.js';
import { getInstructionsFromEditor } from '../rmfilter/instructions.js';
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

    let planText: string | undefined;

    if (options.plan) {
      try {
        planText = await Bun.file(options.plan).text();
      } catch (err) {
        console.error(`Failed to read plan file: ${options.plan}`);
        process.exit(1);
      }
    } else if (options.planEditor) {
      try {
        planText = await getInstructionsFromEditor('rmplan-plan.md');
        if (!planText || !planText.trim()) {
          console.error('No plan text was provided from the editor.');
          process.exit(1);
        }
      } catch (err) {
        console.error('Failed to get plan from editor:', err);
        process.exit(1);
      }
    }

    // planText now contains the loaded plan
    console.log('Loaded plan text:', planText);
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
