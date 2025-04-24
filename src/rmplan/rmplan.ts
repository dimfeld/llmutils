#!/usr/bin/env bun
import { planSchema } from './planSchema.js';
import { logSpawn } from '../rmfilter/utils.js';
import { getInstructionsFromEditor } from '../rmfilter/instructions.js';
import { planPrompt } from './prompt.js';
import clipboardy from 'clipboardy';
import { Command } from 'commander';
import os from 'os';
import path from 'path';

const program = new Command();
program.name('rmplan').description('Generate and execute task plans using LLMs');

program
  .command('generate')
  .description('Generate planning prompt and context for a task')
  .option('--plan <file>', 'Plan text file to use')
  .option('--plan-editor', 'Open plan in editor')
  .allowUnknownOption(true)
  .action(async (options, command) => {
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
    const promptString = planPrompt(planText!);
    const tmpPromptPath = path.join(os.tmpdir(), `rmplan-prompt-${Date.now()}.md`);
    let wrotePrompt = false;
    try {
      await Bun.write(tmpPromptPath, promptString);
      wrotePrompt = true;
      console.log('Prompt written to:', tmpPromptPath);

      // Call rmfilter with constructed args
      const rmfilterFullArgs = [
        'rmfilter',
        ...rmfilterArgs,
        '--bare',
        '--instructions',
        `@${tmpPromptPath}`,
      ];
      const proc = logSpawn(rmfilterFullArgs, { stdio: ['inherit', 'inherit', 'inherit'] });
      const exitRes = await proc.exited;
      if (exitRes !== 0) {
        console.error(`rmfilter exited with code ${exitRes}`);
        process.exit(exitRes ?? 1);
      }
    } finally {
      if (wrotePrompt) {
        try {
          await Bun.file(tmpPromptPath).unlink();
        } catch (e) {
          console.warn('Warning: failed to clean up temp file:', tmpPromptPath);
        }
      }
    }
    console.log('Options:', options);
    console.log('rmfilter args:', rmfilterArgs);
  });

program
  .command('extract [inputFile]')
  .description('Extract and validate a plan YAML from text')
  .option('-o, --output <outputFile>', 'Write result to a file instead of stdout')
  .action(async (inputFile, options) => {
    let inputText: string;
    if (inputFile) {
      inputText = await Bun.file(inputFile).text();
    } else if (!process.stdin.isTTY) {
      inputText = await Bun.stdin.text();
    } else {
      inputText = await clipboardy.read();
    }
    console.log('inputText:', inputText);
    console.log('outputFile:', options.output);
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
