#!/usr/bin/env bun
import clipboardy from 'clipboardy';
import { Command } from 'commander';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import { getInstructionsFromEditor } from '../rmfilter/instructions.js';
import { getGitRoot, logSpawn, setDebug, setQuiet } from '../rmfilter/utils.js';
import { findFilesCore, type RmfindOptions } from '../rmfind/core.js';
import {
  findPendingTask,
  markStepDone,
  prepareNextStep,
  executePostApplyCommand,
  extractMarkdownToYaml,
} from './actions.js';
import { convertMarkdownToYaml, findYamlStart, cleanupEolComments } from './cleanup.js';
import { loadEffectiveConfig } from './configLoader.js';
import { planSchema } from './planSchema.js';
import { planPrompt } from './prompt.js';
import { closeLogFile, error, log, openLogFile, warn } from '../logging.js';
import { DEFAULT_RUN_MODEL, runStreamingPrompt } from '../common/run_and_apply.js';
import { applyLlmEdits } from '../apply-llm-edits/apply.js';

const program = new Command();
program.name('rmplan').description('Generate and execute task plans using LLMs');
program
  .option(
    '-c, --config <path>',
    'Specify path to the rmplan configuration file (default: .rmfilter/rmplan.yml)'
  )
  .option('--debug', 'Enable debug logging', () => setDebug(true));

program
  .command('generate')
  .description('Generate planning prompt and context for a task')
  .option('--plan <file>', 'Plan text file to use')
  .option('--plan-editor', 'Open plan in editor')
  .option('--autofind', 'Automatically find relevant files based on plan')
  .option('--quiet', 'Suppress informational output')
  .option(
    '--no-extract',
    'Do not automatically run the extract command after generating the prompt'
  )
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(async (options, command) => {
    // Find '--' in process.argv to get extra args for rmfilter
    const doubleDashIdx = process.argv.indexOf('--');
    const rmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];

    // Manual conflict check for --plan and --plan-editor
    if ((options.plan && options.planEditor) || (!options.plan && !options.planEditor)) {
      error('You must provide either --plan <file> or --plan-editor (but not both).');
      process.exit(1);
    }

    let planText: string | undefined;

    if (options.plan) {
      try {
        planText = await Bun.file(options.plan).text();
      } catch (err) {
        error(`Failed to read plan file: ${options.plan}`);
        process.exit(1);
      }
    } else if (options.planEditor) {
      try {
        planText = await getInstructionsFromEditor('rmplan-plan.md');
        if (!planText || !planText.trim()) {
          error('No plan text was provided from the editor.');
          process.exit(1);
        }
      } catch (err) {
        error('Failed to get plan from editor:', err);
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
      log('Prompt written to:', tmpPromptPath);

      // Call rmfilter with constructed args
      let additionalFiles: string[] = [];
      if (options.autofind) {
        log('[Autofind] Searching for relevant files based on plan...');
        const gitRoot = (await getGitRoot()) || process.cwd();
        const query = planText!;

        const rmfindOptions: RmfindOptions = {
          baseDir: gitRoot,
          query: query,
          classifierModel: process.env.RMFIND_CLASSIFIER_MODEL || process.env.RMFIND_MODEL,
          grepGeneratorModel: process.env.RMFIND_GREP_GENERATOR_MODEL || process.env.RMFIND_MODEL,
          globs: [],
          quiet: options.quiet ?? false,
        };

        try {
          const rmfindResult = await findFilesCore(rmfindOptions);
          if (rmfindResult && rmfindResult.files.length > 0) {
            if (!options.quiet) {
              log(`[Autofind] Found ${rmfindResult.files.length} potentially relevant files:`);
              rmfindResult.files.forEach((f) => log(`  - ${path.relative(gitRoot, f)}`));
            }
            additionalFiles = rmfindResult.files.map((f) => path.relative(gitRoot, f));
          }
        } catch (error) {
          warn(
            `[Autofind] Warning: Failed to find files: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Append autofound files to rmfilter args
      const rmfilterFullArgs = [
        'rmfilter',
        ...rmfilterArgs,
        '--',
        ...additionalFiles,
        '--bare',
        '--copy',
        '--instructions',
        `@${tmpPromptPath}`,
      ];
      const proc = logSpawn(rmfilterFullArgs, { stdio: ['inherit', 'inherit', 'inherit'] });
      exitRes = await proc.exited;

      if (exitRes === 0 && !options.noExtract) {
        log(
          'Please paste the prompt into the chat interface and copy the response. Press Enter to extract the copied Markdown to a YAML plan file, or Ctrl+C to exit.'
        );

        // Wait for Enter key
        await new Promise<void>((resolve, reject) => {
          process.stdin.setRawMode(true);
          process.stdin.resume();
          process.stdin.on('data', (data) => {
            if (data[0] === 0x0d || data[0] === 0x0a) {
              // Enter key
              process.stdin.setRawMode(false);
              process.stdin.pause();
              resolve();
            }
          });
        });

        let input = await clipboardy.read();
        let outputFilename: string | undefined;
        if (options.plan) {
          outputFilename = path.join(
            path.dirname(options.plan),
            path.basename(options.plan, '.md') + '.yml'
          );
        }
        const outputYaml = await extractMarkdownToYaml(input, options.quiet ?? false);
        if (outputFilename) {
          await Bun.write(outputFilename, outputYaml);
          if (!options.quiet) {
            log(`Wrote result to ${outputFilename}`);
          }
        } else {
          console.log(outputYaml);
        }
      }
    } finally {
      if (wrotePrompt) {
        try {
          await Bun.file(tmpPromptPath).unlink();
        } catch (e) {
          warn('Warning: failed to clean up temp file:', tmpPromptPath);
        }
      }
    }

    if (exitRes !== 0) {
      error(`rmfilter exited with code ${exitRes}`);
      process.exit(exitRes ?? 1);
    }
  });

program
  .command('extract [inputFile]')
  .description('Convert a Markdown project plan into YAML')
  .option('-o, --output <outputFile>', 'Write result to a file instead of stdout')
  .option(
    '--plan <planFile>',
    'The path of the original Markdown project description file. If set, rmplan will write the output to the same path, but with a .yml extension.'
  )
  .option('--quiet', 'Suppress informational output')
  .allowExcessArguments(true)
  .action(async (inputFile, options) => {
    setQuiet(options.quiet);

    let inputText: string;
    if (inputFile) {
      inputText = await Bun.file(inputFile).text();
    } else if (!process.stdin.isTTY) {
      inputText = await Bun.stdin.text();
    } else {
      inputText = await clipboardy.read();
    }

    if (options.plan && !options.output) {
      options.output = path.join(
        path.dirname(options.plan),
        path.basename(options.plan, '.md') + '.yml'
      );
    }

    try {
      const outputYaml = await extractMarkdownToYaml(inputText, options.quiet ?? false);
      if (options.output) {
        let outputFilename = options.output;
        if (outputFilename.endsWith('.md')) {
          outputFilename = outputFilename.slice(0, -3);
          outputFilename += '.yml';
        }
        await Bun.write(outputFilename, outputYaml);
        if (!options.quiet) {
          log(`Wrote result to ${outputFilename}`);
        }
      } else {
        console.log(outputYaml);
      }
    } catch (e) {
      process.exit(1);
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
            error(`rmfilter exited with code ${exitRes}`);
            process.exit(exitRes ?? 1);
          }
        } finally {
          try {
            await Bun.file(result.promptFilePath).unlink();
          } catch (e) {
            warn('Warning: failed to clean up temp file:', result.promptFilePath);
          }
        }
      } else {
        log('\n----- LLM PROMPT -----\n');
        log(result.prompt);
        log('\n---------------------\n');
        await clipboardy.write(result.prompt);
        log('Prompt copied to clipboard');
      }
    } catch (err) {
      error('Failed to process plan file:', err);
      process.exit(1);
    }
  });

program
  .command('cleanup [files...]')
  .description('Remove end-of-line comments from changed files or specified files')
  .option(
    '--diff-from <branch>',
    'Compare to this branch/revision when no files provided. Default is current diff'
  )
  .action(async (files, options) => {
    try {
      await cleanupEolComments(options.diffFrom, files);
    } catch (err) {
      error('Failed to cleanup comments:', err);
      process.exit(1);
    }
  });

program
  .command('agent <planFile>')
  .description('Automatically execute steps in a plan YAML file')
  .option('-m, --model <model>', 'Model to use for LLM')
  .option('--steps <steps>', 'Number of steps to execute')
  .option('--no-log', 'Do not log to file')
  .allowExcessArguments(true)
  .action(async (planFile, options) => {
    if (!options['no-log']) {
      let lastDot = planFile.lastIndexOf('.');
      let logFilePath = lastDot !== -1 ? planFile.slice(0, lastDot) : planFile;
      logFilePath += '-agent-output.md';
      openLogFile(logFilePath);
    }

    const config = await loadEffectiveConfig(options.config);

    log('Starting agent to execute plan:', planFile /*, 'with config:', config */);
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
          error('Failed to parse YAML:', err);
          process.exit(1);
        }

        const planResult = planSchema.safeParse(parsed);
        if (!planResult.success) {
          error('Validation errors:', JSON.stringify(planResult.error.issues, null, 2));
          process.exit(1);
        }

        const planData = planResult.data;
        const pendingTaskInfo = findPendingTask(planData);
        if (!pendingTaskInfo) {
          log('Plan complete!');
          break;
        }

        log(
          `# Iteration ${stepCount}: Task ${pendingTaskInfo.taskIndex + 1}, Step ${pendingTaskInfo.stepIndex + 1}...`
        );
        const stepPreparationResult = await prepareNextStep(planFile, {
          rmfilter: true,
          previous: true,
          selectSteps: false,
        }).catch((err) => {
          error('Failed to prepare next step:', err);
          hasError = true;
          return null;
        });

        if (!stepPreparationResult) {
          break;
        }

        const { promptFilePath, taskIndex, stepIndex, rmfilterArgs } = stepPreparationResult;

        if (!promptFilePath || !rmfilterArgs) {
          error('No prompt file path provided for step execution');
          break;
        }

        log('\n## Generating Context\n');

        const rmfilterOutputPath = promptFilePath.replace('.md', '.xml');
        const proc = logSpawn(['rmfilter', '--output', rmfilterOutputPath, ...rmfilterArgs], {
          stdio: ['inherit', 'inherit', 'inherit'],
        });
        const exitRes = await proc.exited;
        if (exitRes !== 0) {
          error(`rmfilter exited with code ${exitRes}`);
          process.exit(exitRes ?? 1);
        }

        log('\n## Execution\n');

        try {
          let input = await Bun.file(rmfilterOutputPath).text();
          let result = await runStreamingPrompt({
            input,
            model: options.model || DEFAULT_RUN_MODEL,
          });

          let output = await result.text;
          await applyLlmEdits({ content: output });
        } catch (err) {
          error('Execution step failed:', err);
          hasError = true;
          break;
        }

        // ---> NEW: Execute Post-Apply Commands <---
        if (config.postApplyCommands && config.postApplyCommands.length > 0) {
          log('\n## Running Post-Apply Commands\n');
          for (const commandConfig of config.postApplyCommands) {
            const commandSucceeded = await executePostApplyCommand(commandConfig);
            if (!commandSucceeded) {
              // Error logging is handled within executePostApplyCommand
              error(`Agent stopping because required command "${commandConfig.title}" failed.`);
              hasError = true;
              break;
            }
          }
          if (hasError) {
            break;
          }
        }
        // ---> END NEW SECTION <---
        let markResult;
        try {
          log('## Marking done\n');
          markResult = await markStepDone(
            planFile,
            { steps: 1, commit: true },
            { taskIndex, stepIndex }
          );
          log(`Marked step as done: ${markResult.message}`);
          if (markResult.planComplete) {
            log('Plan fully completed!');
            break;
          }
        } catch (err) {
          error('Failed to mark step as done:', err);
          hasError = true;
          break;
        } finally {
          try {
            await Bun.file(promptFilePath).unlink();
          } catch (e) {
            warn('Warning: failed to clean up temp file:', promptFilePath);
          }
        }
      }

      await closeLogFile();

      if (hasError) {
        error('Agent stopped due to error.');
        process.exit(1);
      }
    } catch (err) {
      error('Unexpected error during agent execution:', err);
      error('Agent stopped due to error.');
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
