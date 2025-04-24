#!/usr/bin/env bun
import yaml from 'yaml';
import { planSchema, type PlanSchema } from './planSchema.js';
import { generateObject, generateText } from 'ai';
import { createModel } from '../common/model_factory.js';
import { logSpawn } from '../rmfilter/utils.js';
import { getInstructionsFromEditor } from '../rmfilter/instructions.js';
import { planExampleFormat, planPrompt } from './prompt.js';
import clipboardy from 'clipboardy';
import { Command } from 'commander';
import os from 'os';
import path from 'path';
import { cleanupYaml } from './cleanup.js';
import { select } from '@inquirer/prompts';

interface PendingTaskResult {
  task: PlanSchema['tasks'][number];
  taskIndex: number;
  stepIndex?: number;
}

function findPendingTask(planData: PlanSchema): PendingTaskResult | null {
  for (let i = 0; i < planData.tasks.length; i++) {
    const task = planData.tasks[i];

    // Find first unfinished step in task
    for (let j = 0; j < task.steps.length; j++) {
      if (!task.steps[j].done) {
        return { task, taskIndex: i, stepIndex: j };
      }
    }
  }
  return null;
}

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

    let validatedPlan: unknown;

    const match = inputText.match(/```yaml\n([\s\S]*?)\n```/i);
    const rawYaml = match ? match[1] : inputText;
    try {
      const parsedObject = yaml.parse(rawYaml);
      validatedPlan = planSchema.parse(parsedObject);
    } catch (e) {
      // ignore since we're going to the next try
    }

    if (!validatedPlan) {
      // Use Gemini Flash to clean up the text to valid YAML
      console.warn('YAML parsing failed, attempting LLM cleanup...');
      const result = await cleanupYaml(inputText);

      let cleanedYaml = result;
      const match = cleanedYaml.match(/```yaml\n([\s\S]*?)\n```/i);
      let rawYaml = match ? match[1] : cleanedYaml;
      try {
        const parsedObject = yaml.parse(rawYaml);
        const result = planSchema.safeParse(parsedObject);
        if (!result.success) {
          console.error('Validation errors:', result.error);
          process.exit(1);
        }
        validatedPlan = result.data;
      } catch (e3) {
        console.error('Failed to parse YAML even after Gemini Flash cleanup.');
        process.exit(1);
      }
    }

    const outputYaml = yaml.stringify(validatedPlan);
    if (options.output) {
      await Bun.write(options.output, outputYaml);
    } else {
      console.log(outputYaml);
    }
  });

program
  .command('done <planFile>')
  .description('Mark the next step/task in a plan YAML as done')
  .option('--task', 'Mark all steps in the current task as done')
  .action(async (planFile, options) => {
    try {
      const fileContent = await Bun.file(planFile).text();
      const parsed = yaml.parse(fileContent);
      const result = planSchema.safeParse(parsed);

      if (!result.success) {
        console.error('Validation errors:', result.error);
        process.exit(1);
      }

      const planData = result.data;

      const pending = findPendingTask(planData);
      if (!pending) {
        console.log('All steps are already done.');
        process.exit(0);
      }

      // Mark the appropriate steps as done
      const task = pending.task;
      if (options.task) {
        for (const step of task.steps) {
          step.done = true;
        }
        console.log(`Marked all steps in task '${task.title}' done`);
      } else {
        task.steps[pending.stepIndex!].done = true;
        console.log(`Marked task '${task.title}' step ${pending.stepIndex! + 1} done`);
      }

      // Write the updated plan back to file
      await Bun.write(planFile, yaml.stringify(planData));
    } catch (err) {
      console.error('Failed to process plan file:', err);
      process.exit(1);
    }
  });

program
  .command('next <planFile>')
  .description('Prepare the next step(s) from a plan YAML for execution')
  .action(async (planFile) => {
    try {
      const fileContent = await Bun.file(planFile).text();
      const parsed = yaml.parse(fileContent);
      const plan = planSchema.safeParse(parsed);

      if (!plan.success) {
        console.error('Validation errors:', plan.error);
        process.exit(1);
      }

      const planData = plan.data;
      const result = findPendingTask(planData);
      if (!result) {
        console.log('No pending steps found in the plan.');
        process.exit(0);
      }
      const activeTask = result.task;

      // Separate completed and pending steps
      const completedSteps = activeTask.steps.filter((step) => step.done);
      const pendingSteps = activeTask.steps.filter((step) => !step.done);

      if (pendingSteps.length === 0) {
        console.log('No pending steps in the current task.');
        process.exit(0);
      }

      // Prompt user to select steps
      const selectedIndex = await select({
        message: 'Run up to which step?',
        choices: pendingSteps.map((step, index) => ({
          name: `[${index + 1}] ${step.prompt.split('\n')[0]}...`,
          description: step.prompt,
          value: index,
        })),
      });
      const selectedPendingSteps = pendingSteps.slice(0, selectedIndex + 1);
      // You can now use selectedSteps as needed for the next action
      console.log(
        'Selected steps:',
        selectedPendingSteps.map((s) => s.prompt)
      );
    } catch (err) {
      console.error('Failed to process plan file:', err);
      process.exit(1);
    }
  });

program.parse(process.argv);
