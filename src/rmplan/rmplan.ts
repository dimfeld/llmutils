#!/usr/bin/env bun
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import os from 'os';
import path from 'path';
import * as fs from 'fs/promises';
import yaml from 'yaml';
import * as clipboard from '../common/clipboard.ts';
import { loadEnv } from '../common/env.js';
import { getInstructionsFromGithubIssue, fetchIssueAndComments } from '../common/github/issues.js';
import { parsePrOrIssueNumber } from '../common/github/identifiers.js';
import { waitForEnter } from '../common/terminal.js';
import { error, log, warn } from '../logging.js';
import { getInstructionsFromEditor } from '../rmfilter/instructions.js';
import { getGitRoot, logSpawn, setDebug, setQuiet } from '../rmfilter/utils.js';
import { findFilesCore, type RmfindOptions } from '../rmfind/core.js';
import { handleRmprCommand } from '../rmpr/main.js';
import {
  argsFromRmprOptions,
  parseCommandOptionsFromComment,
  type RmprOptions,
} from '../rmpr/comment_options.js';
import {
  extractMarkdownToYaml,
  markStepDone,
  prepareNextStep,
  gatherPhaseGenerationContext,
  type ExtractMarkdownToYamlOptions,
} from './actions.js';
import { rmplanAgent } from './agent.js';
import { cleanupEolComments } from './cleanup.js';
import { loadEffectiveConfig } from './configLoader.js';
import { planPrompt, generatePhaseStepsPrompt } from './prompt.js';
import { executors } from './executors/index.js';
import { DEFAULT_EXECUTOR } from './constants.js';
import { sshAwarePasteAction } from '../common/ssh_detection.ts';
import { WorkspaceAutoSelector } from './workspace/workspace_auto_selector.js';
import { WorkspaceLock } from './workspace/workspace_lock.js';
import { generateText } from 'ai';
import { createModel } from '../common/model_factory.ts';
import { parseMarkdownPlan, type ParsedPhase } from './markdown_parser.js';
import { generateProjectId, generatePhaseId, slugify } from './id_utils.js';
import { phaseSchema, type PhaseSchema } from './planSchema.js';
import { runRmfilterProgrammatically } from '../rmfilter/rmfilter.js';

await loadEnv();

async function generateSuggestedFilename(planText: string, config: any): Promise<string> {
  try {
    // Extract first 500 characters of the plan for context
    const planSummary = planText.slice(0, 500);

    const prompt = `Given this plan text, suggest a concise and descriptive filename (without extension). 
The filename should:
- Be lowercase with hyphens between words
- Be descriptive of the main task or feature
- Be 3-8 words maximum
- Not include dates or version numbers

Plan text:
${planSummary}

Respond with ONLY the filename, nothing else.`;

    const model = createModel('google/gemini-2.0-flash');
    const result = await generateText({
      model,
      prompt,
      maxTokens: 50,
      temperature: 0.3,
    });

    let filename = result.text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    // Ensure it's not empty and has reasonable length
    if (!filename || filename.length < 3) {
      filename = 'rmplan-task';
    }

    // Add to tasks directory if configured
    const tasksDir = config.paths?.tasks;
    const fullPath = tasksDir ? path.join(tasksDir, `${filename}.md`) : `${filename}.md`;

    return fullPath;
  } catch (err) {
    // Fallback to default if model fails
    warn('Failed to generate filename suggestion:', err);
    return '';
  }
}

const program = new Command();
program.name('rmplan').description('Generate and execute task plans using LLMs');
program.option(
  '-c, --config <path>',
  'Specify path to the rmplan configuration file (default: .rmfilter/rmplan.yml)'
);

program.option('--debug', 'Enable debug logging', () => setDebug(true));

program
  .command('generate')
  .description('Generate planning prompt and context for a task')
  .option('--plan <file>', 'Plan text file to use')
  .option('--plan-editor', 'Open plan in editor')
  .option('--issue <url|number>', 'Issue URL or number to use for the plan text')
  .option('--autofind', 'Automatically find relevant files based on plan')
  .option('--quiet', 'Suppress informational output')
  .option(
    '--no-extract',
    'Do not automatically run the extract command after generating the prompt'
  )
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(async (options, command) => {
    const globalOpts = program.opts();
    const config = await loadEffectiveConfig(globalOpts.config);
    const gitRoot = (await getGitRoot()) || process.cwd();

    // Find '--' in process.argv to get extra args for rmfilter
    const doubleDashIdx = process.argv.indexOf('--');
    const userCliRmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];

    let planOptionsSet = [options.plan, options.planEditor, options.issue].reduce(
      (acc, val) => acc + (val ? 1 : 0),
      0
    );

    // Manual conflict check for --plan and --plan-editor
    if (planOptionsSet !== 1) {
      error(
        'You must provide one and only one of --plan <file>, --plan-editor, or --issue <url|number>'
      );
      process.exit(1);
    }

    let planText: string | undefined;
    let combinedRmprOptions: RmprOptions | null = null;
    let issueResult: Awaited<ReturnType<typeof getInstructionsFromGithubIssue>> | undefined;
    let issueUrlsForExtract: string[] = [];

    let planFile = options.plan;

    if (options.plan) {
      try {
        planText = await Bun.file(options.plan).text();
        planFile = options.plan;
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

        // Copy the plan to clipboard
        await clipboard.write(planText);
        log(chalk.green('✓ Plan copied to clipboard'));

        // Generate suggested filename using Gemini Flash 2.0
        let suggestedFilename = await generateSuggestedFilename(planText, config);

        // Prompt for save location
        let savePath = await input({
          message: 'Save plan to this file (or clear the line to skip): ',
          required: false,
          default: suggestedFilename,
        });

        if (savePath) {
          try {
            await Bun.write(savePath, planText);
            planFile = savePath;
            log('Plan saved to:', savePath);
          } catch (err) {
            error('Failed to save plan to file:', err);
            process.exit(1);
          }
        }
      } catch (err) {
        error('Failed to get plan from editor:', err);
        process.exit(1);
      }
    } else if (options.issue) {
      issueResult = await getInstructionsFromGithubIssue(options.issue);
      planText = issueResult.plan;
      // Extract combinedRmprOptions from the result if it exists
      combinedRmprOptions = issueResult.rmprOptions ?? null;

      // Construct the issue URL
      issueUrlsForExtract.push(issueResult.issue.url);

      let tasksDir = config.paths?.tasks;
      let suggestedFilename = tasksDir
        ? path.join(tasksDir, issueResult.suggestedFileName)
        : issueResult.suggestedFileName;

      let savePath = await input({
        message: 'Save plan to this file (or clear the line to skip): ',
        required: false,
        default: suggestedFilename,
      });

      if (savePath) {
        try {
          await Bun.write(savePath, planText);
          planFile = savePath;
          log('Plan saved to:', savePath);
        } catch (err) {
          error('Failed to save plan to file:', err);
          process.exit(1);
        }
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

      // Process the combinedRmprOptions if available
      let issueRmfilterOptions: string[] = [];
      if (combinedRmprOptions) {
        issueRmfilterOptions = argsFromRmprOptions(combinedRmprOptions);
        if (issueRmfilterOptions.length > 0 && !options.quiet) {
          log(chalk.blue('Applying rmpr options from issue:'), issueRmfilterOptions.join(' '));
        }
      }

      // Combine user CLI args and issue rmpr options
      const allRmfilterOptions = [...userCliRmfilterArgs, ...issueRmfilterOptions];

      // Append autofound files to rmfilter args
      const rmfilterFullArgs = [
        'rmfilter',
        ...allRmfilterOptions,
        '--',
        ...additionalFiles,
        '--bare',
        '--copy',
        '--instructions',
        `@${tmpPromptPath}`,
      ];
      const proc = logSpawn(rmfilterFullArgs, {
        cwd: gitRoot,
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      exitRes = await proc.exited;

      if (exitRes === 0 && !options.noExtract) {
        log(
          chalk.bold(
            `\nPlease paste the prompt into the chat interface. Then ${sshAwarePasteAction()} to extract the copied Markdown to a YAML plan file, or Ctrl+C to exit.`
          )
        );

        let input = await waitForEnter(true);

        let outputFilename: string | undefined;
        if (planFile) {
          outputFilename = path.join(
            path.dirname(planFile),
            path.basename(planFile, '.md') + '.yml'
          );
        }
        const extractOptions: ExtractMarkdownToYamlOptions = {
          planRmfilterArgs: allRmfilterOptions,
          issueUrls: issueUrlsForExtract,
        };

        const outputYaml = await extractMarkdownToYaml(
          input,
          config,
          options.quiet ?? false,
          extractOptions
        );
        if (outputFilename) {
          // no need to print otherwise, extractMarkdownToYaml already did
          await Bun.write(outputFilename, outputYaml);
          if (!options.quiet) {
            log(`Wrote result to ${outputFilename}`);
          }
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
      inputText = await clipboard.read();
    }

    if (options.plan && !options.output) {
      let name = options.plan.endsWith('.yml')
        ? options.plan
        : path.basename(options.plan, '.md') + '.yml';
      options.output = path.join(path.dirname(options.plan), name);
    }

    try {
      const config = await loadEffectiveConfig(options.config);
      const outputYaml = await extractMarkdownToYaml(inputText, config, options.quiet ?? false, {});
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
    const gitRoot = (await getGitRoot()) || process.cwd();
    const result = await markStepDone(
      planFile,
      {
        task: options.task,
        steps: options.steps ? parseInt(options.steps, 10) : 1,
        commit: options.commit,
      },
      undefined,
      gitRoot
    );

    // If plan is complete and we're in a workspace, release the lock
    if (result.planComplete) {
      try {
        await WorkspaceLock.releaseLock(gitRoot);
        log('Released workspace lock');
      } catch (err) {
        // Ignore lock release errors - workspace might not be locked
      }
    }
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
  .option('--with-importers', 'Include importers of files found in the prompt or task files')
  .option('--autofind', 'Automatically run rmfind to find relevant files based on the plan task')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(async (planFile, options) => {
    // Find '--' in process.argv to get extra args for rmfilter
    const doubleDashIdx = process.argv.indexOf('--');
    const cmdLineRmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];
    const config = await loadEffectiveConfig(options.config);
    const gitRoot = (await getGitRoot()) || process.cwd();

    try {
      const result = await prepareNextStep(
        config,
        planFile,
        {
          rmfilter: options.rmfilter,
          previous: options.previous,
          withImports: options.withImports,
          withAllImports: options.withAllImports,
          withImporters: options.withImporters,
          selectSteps: true,
          autofind: options.autofind,
          rmfilterArgs: cmdLineRmfilterArgs,
        },
        gitRoot
      );

      if (options.rmfilter && result.promptFilePath && result.rmfilterArgs) {
        try {
          const proc = logSpawn(['rmfilter', '--copy', ...result.rmfilterArgs], {
            cwd: gitRoot,
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
        await clipboard.write(result.prompt);
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
  .command('parse')
  .description('Parse a phase-based markdown plan into YAML files for each phase.')
  .requiredOption('-i, --input <markdownFile>', 'Path to the input phase-based markdown plan file.')
  .requiredOption(
    '-o, --output-dir <outputDir>',
    'Directory to save the generated phase YAML files.'
  )
  .option('--project-id <id>', 'Specify a project ID. If not provided, one will be generated.')
  .option(
    '--issue <issue_number_or_url>',
    'GitHub issue number or URL to associate with the project and use for naming.'
  )
  .action(async (options) => {
    let projectId: string | undefined;
    let markdownContent: string | undefined;

    try {
      // Read the input markdown file
      try {
        markdownContent = await Bun.file(options.input).text();
      } catch (err) {
        error(`Failed to read input file: ${options.input}`);
        error('Error details:', err);
        process.exit(1);
      }

      // Parse the markdown plan
      let parsedPlan;
      try {
        parsedPlan = await parseMarkdownPlan(markdownContent);
      } catch (err) {
        error('Failed to parse markdown plan. The markdown structure may be invalid.');
        error('Error details:', err);

        // Save the problematic markdown for manual inspection
        const errorDir = options.outputDir;
        await fs.mkdir(errorDir, { recursive: true });
        const errorMdPath = path.join(errorDir, 'feature_plan.error.md');
        const errorLogPath = path.join(errorDir, 'parse_error.log');

        await Bun.write(errorMdPath, markdownContent);
        await Bun.write(
          errorLogPath,
          `Parse error at ${new Date().toISOString()}\n\nError: ${err}\n\nStack trace:\n${err instanceof Error ? err.stack : 'No stack trace available'}`
        );

        error(`Original markdown saved to: ${errorMdPath}`);
        error(`Error log saved to: ${errorLogPath}`);
        process.exit(1);
      }

      // Determine the project ID
      let issueUrl: string | undefined;

      if (options.projectId) {
        // Sanitize the provided project ID to ensure it's a valid directory name
        projectId = slugify(options.projectId);
      } else if (options.issue) {
        // Parse the issue
        const issueInfo = await parsePrOrIssueNumber(options.issue);
        if (!issueInfo || !issueInfo.owner || !issueInfo.repo) {
          error(
            'Could not parse GitHub issue URL or number. Please provide a valid issue URL or use --project-id.'
          );
          process.exit(1);
        }

        // Fetch issue details
        const issueData = await fetchIssueAndComments({
          owner: issueInfo.owner,
          repo: issueInfo.repo,
          number: issueInfo.number,
        });

        issueUrl = issueData.issue.url;

        // Create project ID from issue
        const slugTitle = slugify(issueData.issue.title);

        // Truncate slugTitle if it's too long to keep projectId manageable
        const maxSlugLength = 50;
        const truncatedSlugTitle =
          slugTitle.length > maxSlugLength
            ? slugTitle.substring(0, maxSlugLength).replace(/-+$/, '')
            : slugTitle;

        projectId = `issue-${issueData.issue.number}-${truncatedSlugTitle}`;
      } else {
        // Generate project ID from overall goal using LLM
        try {
          const prompt = `Based on the following project goal and details, suggest a very short, concise, slug-style title (2-5 words, lowercase, hyphenated).
Goal: ${parsedPlan.overallGoal}
Details: ${parsedPlan.overallDetails?.substring(0, 200) || ''}
Respond with ONLY the slug-style title.`;

          const model = createModel('google/gemini-2.0-flash');
          const result = await generateText({
            model,
            prompt,
            maxTokens: 20,
            temperature: 0.3,
          });

          const llmGeneratedTitle = slugify(result.text.trim());
          projectId = generateProjectId(llmGeneratedTitle);
        } catch (err) {
          warn('Failed to generate project ID from LLM:', err);
          // Fall back to a generic projectId
          projectId = generateProjectId('unnamed-project');
        }
      }

      // Log the project ID
      log(chalk.blue('Using Project ID:'), projectId);

      // Create output directory
      // At this point, projectId is guaranteed to be defined
      if (!projectId) {
        throw new Error('Failed to determine project ID');
      }

      const projectDir = path.join(options.outputDir, projectId);
      await fs.mkdir(projectDir, { recursive: true });

      // Create phase schema objects
      const phaseSchemas: PhaseSchema[] = [];
      const phaseIndexToId = new Map<number, string>();

      // First pass: create phase schemas with raw dependencies
      for (const phase of parsedPlan.phases) {
        const phaseId = generatePhaseId(projectId, phase.numericIndex);
        phaseIndexToId.set(phase.numericIndex, phaseId);

        const phaseSchema: PhaseSchema = {
          id: phaseId,
          goal: phase.goal,
          details: phase.details,
          tasks: phase.tasks.map((task) => ({
            title: task.title,
            description: task.description,
            files: [],
            include_imports: false,
            include_importers: false,
            steps: [],
          })),
          status: 'pending',
          priority: 'unknown',
          dependencies: phase.dependencies,
          planGeneratedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          rmfilter: parsedPlan.rmfilter || [],
          issue: issueUrl ? [issueUrl] : [],
        };

        phaseSchemas.push(phaseSchema);
      }

      // Second pass: resolve dependencies
      for (const phaseSchema of phaseSchemas) {
        const resolvedDependencies: string[] = [];

        for (const dep of phaseSchema.dependencies || []) {
          // Extract phase number from strings like "Phase 1", "Phase 2"
          const match = dep.match(/Phase\s+(\d+)/i);
          if (match) {
            const depIndex = parseInt(match[1], 10);
            const depId = phaseIndexToId.get(depIndex);
            if (depId) {
              resolvedDependencies.push(depId);
            } else {
              warn(`Warning: Dependency "${dep}" references a non-existent phase`);
            }
          } else {
            warn(`Warning: Could not parse dependency "${dep}"`);
          }
        }

        phaseSchema.dependencies = resolvedDependencies;
      }

      // Check for circular dependencies
      const hasCycle = detectCircularDependencies(phaseSchemas);
      if (hasCycle) {
        error('Error: Circular dependency detected in phase dependencies');
        error('Please manually edit the phase files to fix the circular dependencies');
        // Continue anyway but warn the user
      }

      // Write phase YAML files
      let successfulWrites = 0;
      const failedPhases: number[] = [];

      for (const phaseSchema of phaseSchemas) {
        const phaseIndex = parseInt(phaseSchema.id.split('-').pop()!, 10);
        const yamlContent = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
${yaml.stringify(phaseSchema)}`;

        const phaseFilePath = path.join(projectDir, `phase_${phaseIndex}.yaml`);

        try {
          await Bun.write(phaseFilePath, yamlContent);
          successfulWrites++;
        } catch (err) {
          warn(`Warning: Failed to write phase ${phaseIndex} YAML file`);
          warn('Error:', err);
          failedPhases.push(phaseIndex);

          // Try to save error version
          try {
            const errorPath = path.join(projectDir, `phase_${phaseIndex}.error.yaml`);
            await Bun.write(errorPath, yamlContent);
            warn(`Saved error version to: ${errorPath}`);
          } catch (saveErr) {
            warn('Failed to save error version:', saveErr);
          }
        }
      }

      if (successfulWrites === 0) {
        error('Failed to write any phase YAML files');
        process.exit(1);
      }

      log(chalk.green(`✓ Successfully parsed markdown plan into ${successfulWrites} phase files`));

      if (failedPhases.length > 0) {
        warn(
          `Warning: Failed to write ${failedPhases.length} phase files: ${failedPhases.join(', ')}`
        );
      }

      log(`Output directory: ${projectDir}`);
    } catch (err) {
      error('Unexpected error during parse operation:', err);

      // Try to save error information
      if (markdownContent && projectId) {
        try {
          const errorDir = path.join(options.outputDir, projectId || 'error');
          await fs.mkdir(errorDir, { recursive: true });
          const errorMdPath = path.join(errorDir, 'feature_plan.error.md');
          const errorLogPath = path.join(errorDir, 'parse_error.log');

          await Bun.write(errorMdPath, markdownContent);
          await Bun.write(
            errorLogPath,
            `Unexpected error at ${new Date().toISOString()}\n\nError: ${err}\n\nStack trace:\n${err instanceof Error ? err.stack : 'No stack trace available'}`
          );

          error(`Original markdown saved to: ${errorMdPath}`);
          error(`Error log saved to: ${errorLogPath}`);
        } catch (saveErr) {
          error('Failed to save error information:', saveErr);
        }
      }

      process.exit(1);
    }
  });

/**
 * Detect circular dependencies in phases
 */
function detectCircularDependencies(phases: PhaseSchema[]): boolean {
  const graph = new Map<string, Set<string>>();

  // Build dependency graph
  for (const phase of phases) {
    if (!graph.has(phase.id)) {
      graph.set(phase.id, new Set());
    }
    for (const dep of phase.dependencies || []) {
      graph.get(phase.id)!.add(dep);
    }
  }

  // DFS to detect cycles
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycleDFS(node: string): boolean {
    visited.add(node);
    recursionStack.add(node);

    const neighbors = graph.get(node) || new Set();
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (hasCycleDFS(neighbor)) return true;
      } else if (recursionStack.has(neighbor)) {
        return true;
      }
    }

    recursionStack.delete(node);
    return false;
  }

  for (const phase of phases) {
    if (!visited.has(phase.id)) {
      if (hasCycleDFS(phase.id)) {
        return true;
      }
    }
  }

  return false;
}

const executorNames = executors
  .values()
  .map((e) => e.name)
  .toArray()
  .join(', ');

program
  .command('agent <planFile>')
  .description('Automatically execute steps in a plan YAML file')
  .option('-m, --model <model>', 'Model to use for LLM')
  .option(`-x, --executor <name>`, 'The executor to use for plan execution')
  .addHelpText('after', `Available executors: ${executorNames}`)
  .option('--steps <steps>', 'Number of steps to execute')
  .option('--no-log', 'Do not log to file')
  .option(
    '--workspace <id>',
    'ID for the task, used for workspace naming and tracking. If provided, a new workspace will be created.'
  )
  .option('--auto-workspace', 'Automatically select an available workspace or create a new one')
  .option(
    '--new-workspace',
    'Allow creating a new workspace. When used with --workspace, creates a new workspace with the specified ID. When used with --auto-workspace, always creates a new workspace instead of reusing existing ones.'
  )
  .option('--non-interactive', 'Do not prompt for user input (e.g., when clearing stale locks)')
  .option('--require-workspace', 'Fail if workspace creation is requested but fails', false)
  .allowExcessArguments(true)
  .action((planFile, options) => rmplanAgent(planFile, options, program.opts()));

program
  .command('workspaces')
  .description('List all workspaces and their lock status')
  .option('--repo <url>', 'Filter by repository URL (defaults to current repo)')
  .action(async (options) => {
    try {
      const globalOpts = program.opts();
      const config = await loadEffectiveConfig(globalOpts.config);
      const trackingFilePath = config.paths?.trackingFile;

      let repoUrl = options.repo;
      if (!repoUrl) {
        // Try to get repo URL from current directory
        try {
          const gitRoot = await getGitRoot();
          const { $ } = await import('bun');
          const result = await $`git remote get-url origin`.cwd(gitRoot).text();
          repoUrl = result.trim();
        } catch (err) {
          error('Could not determine repository URL. Please specify --repo');
          process.exit(1);
        }
      }

      await WorkspaceAutoSelector.listWorkspacesWithStatus(repoUrl, trackingFilePath);
    } catch (err) {
      error('Failed to list workspaces:', err);
      process.exit(1);
    }
  });

program
  .command('generate-phase')
  .description('Generate detailed steps and prompts for a specific phase.')
  .requiredOption('-p, --phase <phaseYamlFile>', 'Path to the phase YAML file.')
  .option('--force', 'Override dependency completion check and proceed with generation.')
  .option('-m, --model <model_id>', 'Specify the LLM model to use for generating phase details.')
  .action(async (options) => {
    const globalOpts = program.opts();

    try {
      // 1. Load RmplanConfig using loadEffectiveConfig
      const config = await loadEffectiveConfig(globalOpts.config);

      // 2. Resolve options.phaseYamlFile to an absolute path
      const phaseYamlFile = path.resolve(options.phase);

      // 3. Load the target phase YAML file
      const phaseContent = await Bun.file(phaseYamlFile).text();
      const parsedPhase = yaml.parse(phaseContent);
      const validationResult = phaseSchema.safeParse(parsedPhase);

      if (!validationResult.success) {
        error('Failed to validate phase YAML:', validationResult.error.issues);
        process.exit(1);
      }

      const currentPhaseData = validationResult.data;

      // 4. Dependency Checking
      for (const dependencyId of currentPhaseData.dependencies || []) {
        // Extract phase index from dependency ID (e.g., "projectid-1" -> "1")
        const phaseIndexMatch = dependencyId.match(/-(\d+)$/);
        if (!phaseIndexMatch) {
          warn(`Warning: Could not parse phase index from dependency ID: ${dependencyId}`);
          continue;
        }

        const phaseIndex = phaseIndexMatch[1];
        const dependencyPath = path.join(path.dirname(phaseYamlFile), `phase_${phaseIndex}.yaml`);

        try {
          const depContent = await Bun.file(dependencyPath).text();
          const parsedDep = yaml.parse(depContent);
          const depValidation = phaseSchema.safeParse(parsedDep);

          if (!depValidation.success) {
            warn(`Warning: Failed to validate dependency ${dependencyId}`);
            continue;
          }

          const depData = depValidation.data;

          if (depData.status !== 'done') {
            const msg = `Dependency ${dependencyId} is not complete (status: ${depData.status}).`;
            warn(msg);

            if (!options.force) {
              error('Cannot proceed without completed dependencies. Use --force to override.');
              process.exit(1);
            }

            warn('Proceeding despite incomplete dependencies due to --force flag.');
          }
        } catch (err) {
          warn(`Warning: Could not read dependency file ${dependencyPath}:`, err);
          if (!options.force) {
            error('Cannot proceed without checking all dependencies. Use --force to override.');
            process.exit(1);
          }
        }
      }

      // 5. Determine projectPlanDir
      const projectPlanDir = path.dirname(phaseYamlFile);

      // 6. Call gatherPhaseGenerationContext
      let phaseGenCtx;
      try {
        phaseGenCtx = await gatherPhaseGenerationContext(phaseYamlFile, projectPlanDir);
      } catch (err) {
        error('Failed to gather phase generation context:', err);

        // Save context gathering error
        try {
          const errorLogPath = phaseYamlFile.replace('.yaml', '.context_error.log');
          await Bun.write(
            errorLogPath,
            `Context gathering error at ${new Date().toISOString()}\n\nError: ${err}\n\nStack trace:\n${err instanceof Error ? err.stack : 'No stack trace available'}`
          );
          error('Error log saved to:', errorLogPath);
        } catch (saveErr) {
          warn('Failed to save error log:', saveErr);
        }

        process.exit(1);
      }

      // 7. Prepare rmfilter arguments for codebase context
      const rmfilterArgs = [...phaseGenCtx.rmfilterArgsFromPlan];

      // Add files from tasks if any are pre-populated
      for (const task of currentPhaseData.tasks) {
        if (task.files && task.files.length > 0) {
          rmfilterArgs.push(...task.files);
        }
      }

      // 8. Invoke rmfilter programmatically
      let codebaseContextXml: string;
      try {
        const gitRoot = (await getGitRoot()) || process.cwd();
        codebaseContextXml = await runRmfilterProgrammatically(
          rmfilterArgs,
          gitRoot,
          projectPlanDir
        );
      } catch (err) {
        error('Failed to execute rmfilter:', err);

        // Save rmfilter error
        try {
          const errorLogPath = phaseYamlFile.replace('.yaml', '.rmfilter_error.log');
          await Bun.write(
            errorLogPath,
            `Rmfilter error at ${new Date().toISOString()}\n\nArgs: ${JSON.stringify(rmfilterArgs, null, 2)}\n\nError: ${err}\n\nStack trace:\n${err instanceof Error ? err.stack : 'No stack trace available'}`
          );
          error('Error log saved to:', errorLogPath);
        } catch (saveErr) {
          warn('Failed to save error log:', saveErr);
        }

        process.exit(1);
      }

      // 9. Construct LLM Prompt for Step Generation
      const phaseStepsPrompt = generatePhaseStepsPrompt(phaseGenCtx);
      const fullPrompt = `${phaseStepsPrompt}

<codebase_context>
${codebaseContextXml}
</codebase_context>`;

      // 10. Call LLM
      const modelId =
        options.model || config.models?.execution || 'anthropic/claude-3-5-sonnet-latest';
      const model = createModel(modelId);

      log('Generating detailed steps for phase using model:', modelId);

      const { text } = await generateText({
        model,
        prompt: fullPrompt,
        maxTokens: 8000,
        temperature: 0.2,
      });

      // 11. Parse LLM Output
      let parsedTasks;
      try {
        // Extract YAML from the response (LLM might include markdown formatting)
        const yamlMatch = text.match(/```yaml\s*([\s\S]*?)\s*```/);
        const yamlContent = yamlMatch ? yamlMatch[1] : text;

        const parsed = yaml.parse(yamlContent);

        // Validate that we got a tasks array
        if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
          throw new Error('LLM output does not contain a valid tasks array');
        }

        parsedTasks = parsed.tasks;
      } catch (err) {
        // Save raw LLM output for debugging
        const errorFilePath = phaseYamlFile.replace('.yaml', '.llm_error.txt');
        const partialErrorPath = phaseYamlFile.replace('.yaml', '.partial_error.yaml');

        try {
          await Bun.write(errorFilePath, text);
          error('Failed to parse LLM output. Raw output saved to:', errorFilePath);

          // Save the current phase YAML state before any modifications
          const currentYaml = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
${yaml.stringify(currentPhaseData)}`;
          await Bun.write(partialErrorPath, currentYaml);
          error('Current phase state saved to:', partialErrorPath);
        } catch (saveErr) {
          error('Failed to save error files:', saveErr);
        }

        error('Parse error:', err);
        error('Please manually correct the LLM output or retry with a different model');
        process.exit(1);
      }

      // 12. Update Phase YAML
      // Merge LLM-generated task details into currentPhaseData.tasks
      for (let i = 0; i < currentPhaseData.tasks.length; i++) {
        const existingTask = currentPhaseData.tasks[i];
        const llmTask = parsedTasks[i];

        if (!llmTask) {
          warn(`Warning: LLM did not generate details for task ${i + 1}: ${existingTask.title}`);
          continue;
        }

        // Update task with LLM-generated details
        existingTask.files = llmTask.files || [];
        existingTask.include_imports = llmTask.include_imports ?? false;
        existingTask.include_importers = llmTask.include_importers ?? false;
        existingTask.steps = llmTask.steps || [];
      }

      // Update timestamps
      currentPhaseData.promptsGeneratedAt = new Date().toISOString();
      currentPhaseData.updatedAt = new Date().toISOString();

      // 13. Write the updated phase YAML back to file
      const updatedYaml = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
${yaml.stringify(currentPhaseData)}`;

      await Bun.write(phaseYamlFile, updatedYaml);

      // 14. Log success
      log(chalk.green('✓ Successfully generated detailed steps for phase'));
      log(`Updated phase file: ${phaseYamlFile}`);
    } catch (err) {
      error('Failed to generate phase details:', err);
      process.exit(1);
    }
  });

program
  .command('answer-pr [prIdentifier]')
  .description(
    'Address Pull Request (PR) review comments using an LLM. If no PR identifier is provided, it will try to detect the PR from the current branch.'
  )
  .option(
    '--mode <mode>',
    "Specify the editing mode. 'inline-comments' (default) inserts comments into code. 'separate-context' adds them to the prompt.",
    'inline-comments'
  )
  .option(`-x, --executor <name>`, 'The executor to use for execution')
  .addHelpText('after', `Available executors: ${executorNames}`)
  .option(
    '--yes',
    'Automatically proceed without interactive prompts (e.g., for reviewing AI comments in files).',
    false
  )
  .option(
    '-m, --model <model>',
    'Specify the LLM model to use. Overrides model from rmplan config.'
  )
  .option(
    '--dry-run',
    'Prepare and print the LLM prompt, but do not call the LLM or apply edits.',
    false
  )
  .option('--commit', 'Commit changes to jj/git', false)
  .option('--comment', 'Post replies to review threads after committing changes', false)
  .action(async (prIdentifier, options) => {
    // Pass global options (like --debug) along with command-specific options
    const globalOpts = program.opts();
    const config = await loadEffectiveConfig(globalOpts.config);

    // Use executor from CLI options, fallback to config defaultExecutor, or fallback to the default executor
    if (!options.executor) {
      options.executor = config.defaultExecutor || DEFAULT_EXECUTOR;
    }

    await handleRmprCommand(prIdentifier, options, globalOpts, config);
  });

await program.parseAsync(process.argv);
