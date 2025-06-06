// Command handler for 'rmplan generate'
// Generates planning prompt and context for a task

import { input } from '@inquirer/prompts';
import { generateText } from 'ai';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import yaml from 'yaml';
import * as clipboard from '../../common/clipboard.ts';
import { getGitRoot } from '../../common/git.js';
import { getInstructionsFromGithubIssue } from '../../common/github/issues.js';
import { createModel } from '../../common/model_factory.ts';
import { logSpawn } from '../../common/process.js';
import { sshAwarePasteAction } from '../../common/ssh_detection.ts';
import { waitForEnter } from '../../common/terminal.js';
import { log, warn } from '../../logging.js';
import { findFilesCore, type RmfindOptions } from '../../rmfind/core.js';
import { argsFromRmprOptions, type RmprOptions } from '../../rmpr/comment_options.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir } from '../configSchema.ts';
import { resolvePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import {
  extractMarkdownToYaml,
  findYamlStart,
  type ExtractMarkdownToYamlOptions,
} from '../process_markdown.ts';
import { planPrompt, simplePlanPrompt } from '../prompt.js';

export async function handleGenerateCommand(options: any, command: any) {
  const globalOpts = command.parent.opts();
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
    throw new Error(
      'You must provide one and only one of --plan <file>, --plan-editor, or --issue <url|number>'
    );
  }

  let planText: string | undefined;
  let combinedRmprOptions: RmprOptions | null = null;
  let issueResult: Awaited<ReturnType<typeof getInstructionsFromGithubIssue>> | undefined;
  let issueUrlsForExtract: string[] = [];

  let planFile: string | undefined = options.plan;

  if (options.plan) {
    const filePath = await resolvePlanFile(options.plan, globalOpts.config);
    const fileContent = await Bun.file(filePath).text();
    planFile = filePath;

    // Check if the file is a YAML plan file by trying to parse it
    let isYamlPlan = false;
    let parsedPlan: PlanSchema | null = null;

    try {
      // Try to parse as YAML
      const yamlContent = findYamlStart(fileContent);
      parsedPlan = yaml.parse(yamlContent) as PlanSchema;

      // Validate that it has plan structure (at least id or goal)
      if (parsedPlan && (parsedPlan.id || parsedPlan.goal)) {
        isYamlPlan = true;
      }
    } catch {
      // Not a valid YAML plan, treat as markdown
      isYamlPlan = false;
    }

    if (isYamlPlan && parsedPlan) {
      // Check if it's a stub plan (no tasks or empty tasks array)
      const isStubPlan = !parsedPlan.tasks || parsedPlan.tasks.length === 0;

      if (!isStubPlan) {
        // Plan already has tasks - log a message and continue with normal flow
        log(
          chalk.yellow(
            'Plan already contains tasks. To regenerate, remove the tasks array from the YAML file.'
          )
        );
        planText = fileContent;
      } else {
        // It's a stub plan - we'll handle task generation below
        // For now, set planText to null to trigger special handling
        planText = null as any;
      }
    } else {
      // Regular markdown file
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
      let suggestedFilename = await generateSuggestedFilename(planText, config);

      // Prompt for save location
      let savePath = await input({
        message: 'Save plan to this file (or clear the line to skip): ',
        required: false,
        default: suggestedFilename,
      });

      if (savePath) {
        // If the path is relative resolve it against the git root
        if (!path.isAbsolute(savePath) && config.paths?.tasks) {
          savePath = path.resolve(gitRoot, suggestedFilename);
        }

        try {
          await Bun.write(savePath, planText);
          planFile = savePath;
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
    let suggestedFilename = config.paths?.tasks
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
        throw new Error(`Failed to save plan to file: ${err as Error}`);
      }
    }
  }

  // Special handling for stub YAML plans
  let stubPlanData: PlanSchema | null = null;
  if (options.plan && planFile && planText === null) {
    // We detected a stub plan earlier, now we need to load it properly
    try {
      const fileContent = await Bun.file(planFile).text();
      const yamlContent = findYamlStart(fileContent);
      stubPlanData = yaml.parse(yamlContent) as PlanSchema;

      const { goal, details } = stubPlanData;
      if (!goal && !details) {
        throw new Error('Stub plan must have at least a goal or details to generate tasks.');
      }

      // Construct planText from stub's title, goal, and details
      const planParts: string[] = [];
      if (stubPlanData.title) {
        planParts.push(`# ${stubPlanData.title}`);
      }
      if (goal) {
        planParts.push(`\n## Goal\n${goal}`);
      }
      if (details) {
        planParts.push(`\n## Details\n${details}`);
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

  // planText now contains the loaded plan
  const promptString = options.simple ? simplePlanPrompt(planText) : planPrompt(planText);
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
    for (const argList of [userCliRmfilterArgs, issueRmfilterOptions, stubPlanData?.rmfilter]) {
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
        if (planFile.endsWith('.yml')) {
          outputPath = planFile;
        } else {
          // Use the directory of the plan file for output
          outputPath = path.join(path.dirname(planFile), path.basename(planFile, '.md'));
        }
      } else {
        // Default to current directory with a generated name
        outputPath = 'rmplan-output';
      }

      const extractOptions: ExtractMarkdownToYamlOptions = {
        output: outputPath,
        planRmfilterArgs: allRmfilterOptions,
        issueUrls: issueUrlsForExtract,
        stubPlanData: stubPlanData || undefined,
        commit: options.commit,
      };

      const result = await extractMarkdownToYaml(
        input,
        config,
        options.quiet ?? false,
        extractOptions
      );

      // If we generated from a stub plan, handle file cleanup
      if (stubPlanData && planFile) {
        // Check if the result indicates multiple files were created
        const isMultiPhase = result.includes('phase files');

        if (isMultiPhase) {
          // Multiple phase files were created in a subdirectory, remove the original stub
          try {
            await fs.unlink(planFile);
            if (!options.quiet) {
              log(chalk.blue('✓ Removed original stub plan file:', planFile));
            }
          } catch (err) {
            warn(`Failed to remove original stub plan: ${err as Error}`);
          }
        } else {
          // Single file was created, it should have overwritten the original
          if (!options.quiet) {
            log(chalk.blue('✓ Updated plan file in place:', outputPath));
          }
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
    throw new Error(`rmfilter exited with code ${exitRes}`);
  }
}

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
