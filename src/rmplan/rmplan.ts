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
  .action(() => {
    console.log('generate...');
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
