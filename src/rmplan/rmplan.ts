#!/usr/bin/env bun
import clipboardy from 'clipboardy';
import { Command } from 'commander';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import { getInstructionsFromEditor } from '../rmfilter/instructions.js';
import { logSpawn } from '../rmfilter/utils.js';
import { findPendingTask, markStepDone, prepareNextStep, runAndApplyChanges } from './actions.js';
import { cleanupYaml } from './cleanup.js';
import { planSchema } from './planSchema.js';
import { planPrompt } from './prompt.js';

const program = new Command();
program.name('rmplan').description('Generate and execute task plans using LLMs');

program
  .command('generate')
  .description('Generate planning prompt and context for a task')
  .option('--plan <file>', 'Plan text file to use')
  .option('--plan-editor', 'Open plan in editor')
  .allowExcessArguments(true)
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
    let exitRes: number | undefined;
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
      exitRes = await proc.exited;
    } finally {
      if (wrotePrompt) {
        try {
          await Bun.file(tmpPromptPath).unlink();
        } catch (e) {
          console.warn('Warning: failed to clean up temp file:', tmpPromptPath);
        }
      }
    }

    if (exitRes !== 0) {
      console.error(`rmfilter exited with code ${exitRes}`);
      process.exit(exitRes ?? 1);
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

    let validatedPlan: unknown;

    function findYamlStart(inputText: string): string {
      const match = inputText.match(/```yaml\n([\s\S]*?)\n```/i);
      if (match) {
        return match[1];
      }

      let goal = inputText.indexOf('goal:');
      if (goal >= 0) {
        return inputText.slice(goal);
      }

      return inputText;
    }

    const rawYaml = findYamlStart(inputText);
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
      const rawYaml = findYamlStart(result);
      try {
        const parsedObject = yaml.parse(rawYaml);
        const result = planSchema.safeParse(parsedObject);
        if (!result.success) {
          console.error('Validation errors:', result.error);
          process.exit(1);
        }
        validatedPlan = result.data;
      } catch (e) {
        await Bun.write('rmplan-clean-failure.yml', result);
        console.error(
          'Failed to parse YAML even after Gemini Flash cleanup. Saved cleaned output to rmplan-clean-failure.yml'
        );
        process.exit(1);
      }
    }

    const outputYaml = yaml.stringify(validatedPlan);
    if (options.output) {
      await Bun.write(options.output, outputYaml);
      console.log(`Wrote result to ${options.output}`);
    } else {
      console.log(outputYaml);
    }
  });

program
  .command('done <planFile>')
  .description('Mark the next step/task in a plan YAML as done')
  .option('--steps <steps>', 'Number of steps to mark as done', '1')
  .option('--task', 'Mark all steps in the current task as done')
  .option('--commit', 'Commit changes to jj/git')
  .action(async (planFile, options) => {
    await markStepDone(planFile, {
      task: options.task,
      steps: options.steps ? parseInt(options.steps, 10) : 1,
      commit: options.commit,
    });
  });

program
  .command('next <planFile>')
  .description('Prepare the next step(s) from a plan YAML for execution')
  .option('--rmfilter', 'Use rmfilter to generate the prompt')
  .option('--previous', 'Include information about previous completed steps')
  .option('--with-imports', 'Include direct imports of files found in the prompt or task files')
  .option(
    '--with-all-imports',
    'Include the entire import tree of files found in the prompt or task files'
  )
  .option('--autofind', 'Automatically run rmfind to find relevant files based on the plan task')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(async (planFile, options) => {
    // Find '--' in process.argv to get extra args for rmfilter
    const doubleDashIdx = process.argv.indexOf('--');
    const cmdLineRmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];

    try {
      const result = await prepareNextStep(planFile, {
        rmfilter: options.rmfilter,
        previous: options.previous,
        withImports: options.withImports,
        withAllImports: options.withAllImports,
        selectSteps: true,
        autofind: options.autofind,
        rmfilterArgs: cmdLineRmfilterArgs,
      });

      if (options.rmfilter && result.promptFilePath && result.rmfilterArgs) {
        try {
          const proc = logSpawn(['rmfilter', '--copy', ...result.rmfilterArgs], {
            stdio: ['inherit', 'inherit', 'inherit'],
          });
          const exitRes = await proc.exited;
          if (exitRes !== 0) {
            console.error(`rmfilter exited with code ${exitRes}`);
            process.exit(exitRes ?? 1);
          }
        } finally {
          try {
            await Bun.file(result.promptFilePath).unlink();
          } catch (e) {
            console.warn('Warning: failed to clean up temp file:', result.promptFilePath);
          }
        }
      } else {
        console.log('\n----- LLM PROMPT -----\n');
        console.log(result.prompt);
        console.log('\n---------------------\n');
        await clipboardy.write(result.prompt);
        console.log('Prompt copied to clipboard');
      }
    } catch (err) {
      console.error('Failed to process plan file:', err);
      process.exit(1);
    }
  });

program
  .command('agent <planFile>')
  .description('Automatically execute steps in a plan YAML file')
  .option('-m, --model <model>', 'Model to use for LLM')
  .option('--steps <steps>', 'Number of steps to execute')
  .allowExcessArguments(true)
  .action(async (planFile, options) => {
    console.log('Starting agent to execute plan:', planFile);
    try {
      let hasError = false;

      const maxSteps = options.steps ? parseInt(options.steps, 10) : Infinity;
      let stepCount = 0;
      while (stepCount < maxSteps) {
        stepCount++;

        const fileContent = await Bun.file(planFile).text();
        let parsed;
        try {
          parsed = yaml.parse(fileContent);
        } catch (err) {
          console.error('Failed to parse YAML:', err);
          process.exit(1);
        }

        const planResult = planSchema.safeParse(parsed);
        if (!planResult.success) {
          console.error('Validation errors:', JSON.stringify(planResult.error.issues, null, 2));
          process.exit(1);
        }

        const planData = planResult.data;
        const pendingTaskInfo = findPendingTask(planData);
        if (!pendingTaskInfo) {
          console.log('Plan complete!');
          break;
        }

        console.log(
          `# Iteration ${stepCount}: Task ${pendingTaskInfo.taskIndex + 1}, Step ${pendingTaskInfo.stepIndex + 1}...`
        );
        const stepPreparationResult = await prepareNextStep(planFile, {
          rmfilter: true,
          selectSteps: false,
        }).catch((err) => {
          console.error('Failed to prepare next step:', err);
          hasError = true;
          return null;
        });

        if (!stepPreparationResult) {
          break;
        }

        const { promptFilePath, taskIndex, stepIndex, rmfilterArgs } = stepPreparationResult;

        if (!promptFilePath || !rmfilterArgs) {
          console.error('No prompt file path provided for step execution');
          break;
        }

        console.log('\n## Generating Context\n');

        const rmfilterOutputPath = promptFilePath.replace('.md', '.xml');
        const proc = logSpawn(['rmfilter', '--output', rmfilterOutputPath, ...rmfilterArgs], {
          stdio: ['inherit', 'inherit', 'inherit'],
        });
        const exitRes = await proc.exited;
        if (exitRes !== 0) {
          console.error(`rmfilter exited with code ${exitRes}`);
          process.exit(exitRes ?? 1);
        }

        console.log('\n## Execution\n');
        const applySucceeded = await runAndApplyChanges(rmfilterOutputPath).catch((err: Error) => {
          console.error('Failed to execute step:', err);
          hasError = true;
          return false;
        });

        if (!applySucceeded) {
          console.error('Step execution failed, stopping agent.');
          hasError = true;
          break;
        }

        let markResult;
        try {
          console.log('## Marking done\n');
          markResult = await markStepDone(
            planFile,
            { steps: 1, commit: true },
            { taskIndex, stepIndex }
          );
          console.log(`Marked step as done: ${markResult.message}`);
          if (markResult.planComplete) {
            console.log('Plan fully completed!');
            break;
          }
        } catch (err) {
          console.error('Failed to mark step as done:', err);
          hasError = true;
          break;
        } finally {
          try {
            await Bun.file(promptFilePath).unlink();
          } catch (e) {
            console.warn('Warning: failed to clean up temp file:', promptFilePath);
          }
        }
      }
      if (hasError) {
        console.error('Agent stopped due to error.');
        process.exit(1);
      }
    } catch (err) {
      console.error('Unexpected error during agent execution:', err);
      console.error('Agent stopped due to error.');
      process.exit(1);
    }
  });

program.parse(process.argv);
