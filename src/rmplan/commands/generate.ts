// Command handler for 'rmplan generate'
// Generates planning prompt and context for a task

import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import yaml from 'yaml';
import * as clipboard from '../../common/clipboard.ts';
import { getGitRoot } from '../../common/git.js';
import { getInstructionsFromGithubIssue } from '../../common/github/issues.js';
import { logSpawn } from '../../common/process.js';
import { sshAwarePasteAction } from '../../common/ssh_detection.ts';
import { waitForEnter } from '../../common/terminal.js';
import { log, warn } from '../../logging.js';
import { findFilesCore, type RmfindOptions } from '../../rmfind/core.js';
import { argsFromRmprOptions, type RmprOptions } from '../../rmpr/comment_options.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir } from '../configSchema.ts';
import {
  generateSuggestedFilename,
  readAllPlans,
  readPlanFile,
  resolvePlanFile,
} from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import {
  extractMarkdownToYaml,
  findYamlStart,
  type ExtractMarkdownToYamlOptions,
} from '../process_markdown.ts';
import { planPrompt, simplePlanPrompt } from '../prompt.js';

export async function handleGenerateCommand(
  planArg: string | undefined,
  options: any,
  command: any
) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const gitRoot = (await getGitRoot()) || process.cwd();

  // Find '--' in process.argv to get extra args for rmfilter
  const doubleDashIdx = process.argv.indexOf('--');
  const userCliRmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];

  if (userCliRmfilterArgs[0] === planArg) {
    planArg = undefined;
  }

  let planOptionsSet = [planArg, options.plan, options.planEditor, options.issue].reduce(
    (acc, val) => acc + (val ? 1 : 0),
    0
  );

  // Manual conflict check for --plan and --plan-editor
  if (planOptionsSet !== 1) {
    throw new Error(
      'You must provide one and only one of [plan], --plan <plan>, --plan-editor, or --issue <url|number>'
    );
  }

  if (planArg) {
    options.plan = planArg;
  }

  let planText: string | undefined;
  let combinedRmprOptions: RmprOptions | null = null;
  let issueResult: Awaited<ReturnType<typeof getInstructionsFromGithubIssue>> | undefined;
  let issueUrlsForExtract: string[] = [];

  let planFile: string | undefined = options.plan;
  let parsedPlan: PlanSchema | null = null;

  if (options.plan) {
    const filePath = await resolvePlanFile(options.plan, globalOpts.config);
    planFile = filePath;

    // Check if the file is a YAML plan file by trying to parse it

    try {
      // Try to parse as YAML
      parsedPlan = await readPlanFile(filePath);
      // Validate that it has plan structure (at least id or goal)
      const isStubPlan = !parsedPlan.tasks || parsedPlan.tasks.length === 0;

      if (!isStubPlan) {
        log(
          chalk.yellow(
            'Plan already contains tasks. To regenerate, remove the tasks array from the YAML file.'
          )
        );
        return;
      }
    } catch {
      // Not a valid YAML plan, treat as markdown
      const fileContent = await Bun.file(filePath).text();
      planText = fileContent;
    }
  } else if (options.planEditor) {
    try {
      // Create a temporary file for the plan editor
      const tmpPlanPath = path.join(os.tmpdir(), `rmplan-editor-${Date.now()}.md`);

      // Open editor with the temporary file
      const editor = process.env.EDITOR || 'nano';
      const editorProcess = logSpawn([editor, tmpPlanPath], {
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      await editorProcess.exited;

      // Read the plan text from the temporary file
      try {
        planText = await Bun.file(tmpPlanPath).text();
      } catch (err) {
        throw new Error('Failed to read plan from editor.');
      } finally {
        // Clean up the temporary file
        try {
          await Bun.file(tmpPlanPath).unlink();
        } catch (e) {
          // Ignore cleanup errors
        }
      }

      if (!planText || !planText.trim()) {
        throw new Error('No plan text was provided from the editor.');
      }

      // Copy the plan to clipboard
      await clipboard.write(planText);
      log(chalk.green('✓ Plan copied to clipboard'));

      // Generate suggested filename using Gemini Flash 2.0
      let suggestedFilename = await generateSuggestedFilename(planText, '.plan.md');

      // Prompt for save location
      let savePath = await input({
        message: 'Save plan to this file (or clear the line to skip): ',
        required: false,
        default: suggestedFilename,
      });

      if (savePath) {
        try {
          const tasksDir = await resolveTasksDir(config);
          planFile = path.resolve(tasksDir, savePath);
          await Bun.write(planFile, planText);
          log('Plan saved to:', savePath);
        } catch (err) {
          throw new Error(`Failed to save plan to file: ${err as Error}`);
        }
      }
    } catch (err) {
      throw new Error(`Failed to get plan from editor: ${err as Error}`);
    }
  } else if (options.issue) {
    issueResult = await getInstructionsFromGithubIssue(options.issue);
    planText = issueResult.plan;
    // Extract combinedRmprOptions from the result if it exists
    combinedRmprOptions = issueResult.rmprOptions ?? null;

    // Construct the issue URL
    issueUrlsForExtract.push(issueResult.issue.url);

    let tasksDir = await resolveTasksDir(config);
    let savePath = await input({
      message: 'Save plan to this file (or clear the line to skip): ',
      required: false,
      default: issueResult.suggestedFileName,
    });

    if (savePath) {
      try {
        planFile = path.resolve(tasksDir, savePath);
        await Bun.write(planFile, planText);
        log('Plan saved to:', savePath);
      } catch (err) {
        throw new Error(`Failed to save plan to file: ${err as Error}`);
      }
    }
  }

  // Special handling for stub YAML plans
  let stubPlan: { data: PlanSchema; path: string } | undefined;
  if (parsedPlan && planFile) {
    // We detected a stub plan earlier, now we need to load it properly
    try {
      stubPlan = { data: parsedPlan, path: planFile };

      const { goal, details } = stubPlan.data;
      if (!goal && !details) {
        throw new Error('Stub plan must have at least a goal or details to generate tasks.');
      }

      // Construct planText from stub's title, goal, and details
      const planParts: string[] = [];
      if (stubPlan.data.title) {
        planParts.push(`# ${stubPlan.data.title}`);
      }
      if (goal) {
        planParts.push(`\n## Goal\n${goal}`);
      }
      if (details) {
        planParts.push(`\n## Details\n${details}`);
      }

      // Add parent plan information if available
      if (stubPlan.data.parent) {
        const tasksDir = await resolveTasksDir(config);
        const { plans: allPlans } = await readAllPlans(tasksDir);
        const parentPlan = allPlans.get(stubPlan.data.parent);
        if (parentPlan) {
          planParts.push(
            `\n## Parent Plan Context\n**Parent Plan:** ${parentPlan.title || `Plan ${stubPlan.data.parent}`} (ID: ${stubPlan.data.parent})`
          );
          if (parentPlan.goal) {
            planParts.push(`**Parent Goal:** ${parentPlan.goal}`);
          }
          if (parentPlan.details) {
            planParts.push(`**Parent Details:** ${parentPlan.details}`);
          }
        }
      }

      planText = planParts.join('\n');

      log(chalk.blue('🔄 Detected stub plan. Generating detailed tasks for:'), planFile);
    } catch (err) {
      throw new Error(`Failed to process stub plan: ${err as Error}`);
    }
  }

  if (!planText) {
    throw new Error('No plan text was provided.');
  }

  // Read planning document if configured
  let planningDocContent = '';
  if (config.paths?.planning) {
    const planningPath = path.isAbsolute(config.paths.planning)
      ? config.paths.planning
      : path.join(gitRoot, config.paths.planning);
    const planningFile = Bun.file(planningPath);
    planningDocContent = await planningFile.text();
    log(chalk.blue('📋 Including planning document:'), path.relative(gitRoot, planningPath));
  }

  // Create the prompt with optional planning document
  let fullPlanText = planText;
  if (planningDocContent) {
    fullPlanText = `${planText}\n\n## Planning Rules\n\n${planningDocContent}`;
  }

  // planText now contains the loaded plan
  const promptString = options.simple ? simplePlanPrompt(fullPlanText) : planPrompt(fullPlanText);
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
      const query = planText;

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
    const allRmfilterOptions: string[] = [];
    for (const argList of [userCliRmfilterArgs, issueRmfilterOptions, stubPlan?.data?.rmfilter]) {
      if (!argList?.length) continue;
      // Add a separator if some options already exist
      if (allRmfilterOptions.length) allRmfilterOptions.push('--');
      allRmfilterOptions.push(...argList);
    }

    // Check if no files are provided to rmfilter
    const hasNoFiles = additionalFiles.length === 0 && allRmfilterOptions.length === 0;

    if (hasNoFiles) {
      warn(
        chalk.yellow(
          '\n⚠️  Warning: No files specified for rmfilter. The prompt will only contain the planning instructions without any code context.'
        )
      );

      // Copy the prompt directly to clipboard without running rmfilter
      await clipboard.write(promptString);
      log('Prompt copied to clipboard');
      exitRes = 0;
    } else {
      // Collect docs from stub plan
      const docsArgs: string[] = [];
      if (stubPlan?.data?.docs) {
        stubPlan?.data.docs.forEach((doc) => {
          docsArgs.push('--docs', doc);
        });
      }

      // Append autofound files to rmfilter args
      const rmfilterFullArgs = [
        'rmfilter',
        ...allRmfilterOptions,
        ...docsArgs,
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
    }

    if (exitRes === 0 && options.extract !== false) {
      log(
        chalk.bold(
          `\nPlease paste the prompt into the chat interface. Then ${sshAwarePasteAction()} to extract the copied Markdown to a YAML plan file, or Ctrl+C to exit.`
        )
      );

      let input = await waitForEnter(true);

      let outputPath: string;
      if (planFile) {
        if (planFile.endsWith('.yml') || planFile.endsWith('.plan.md')) {
          outputPath = planFile;
        } else {
          // Use the directory of the plan file for output
          outputPath = path.join(path.dirname(planFile), path.basename(planFile));
        }
      } else {
        // Default to current directory with a generated name
        outputPath = 'rmplan-output';
      }

      const extractOptions: ExtractMarkdownToYamlOptions = {
        output: outputPath,
        planRmfilterArgs: allRmfilterOptions,
        issueUrls: issueUrlsForExtract,
        stubPlan,
        commit: options.commit,
      };

      await extractMarkdownToYaml(input, config, options.quiet ?? false, extractOptions);
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
    throw new Error(`rmfilter exited with code ${exitRes}`);
  }
}
