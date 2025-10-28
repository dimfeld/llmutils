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
import { getIssueTracker } from '../../common/issue_tracker/factory.js';
import { logSpawn } from '../../common/process.js';
import { sshAwarePasteAction } from '../../common/ssh_detection.ts';
import { waitForEnter } from '../../common/terminal.js';
import { log, warn } from '../../logging.js';
import { findFilesCore, type RmfindOptions } from '../../rmfind/core.js';
import { argsFromRmprOptions, type RmprOptions } from '../../rmpr/comment_options.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanPathContext } from '../path_resolver.js';
import { createModel } from '../../common/model_factory.js';
import { DEFAULT_RUN_MODEL, runStreamingPrompt } from '../llm_utils/run_and_apply.js';
import { generateNumericPlanId, slugify } from '../id_utils.js';
import {
  generateSuggestedFilename,
  readAllPlans,
  readPlanFile,
  resolvePlanFile,
  writePlanFile,
} from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { getCombinedTitle } from '../display_utils.js';
import {
  extractMarkdownToYaml,
  findYamlStart,
  type ExtractMarkdownToYamlOptions,
} from '../process_markdown.ts';
import {
  planPrompt,
  simplePlanPrompt,
  generateClaudeCodePlanningPrompt,
  generateClaudeCodeGenerationPrompt,
  generateClaudeCodeResearchPrompt,
  generateClaudeCodeSimplePlanningPrompt,
} from '../prompt.js';
import { getInstructionsFromIssue, type IssueInstructionData } from '../issue_utils.js';
import { updatePlanProperties } from '../planPropertiesUpdater.js';
import { invokeClaudeCodeForGeneration } from '../claude_utils.js';
import { findNextReadyDependency } from './find_next_dependency.js';
import { isURL } from '../context_helpers.ts';
import { autoClaimPlan, isAutoClaimEnabled } from '../assignments/auto_claim.js';
import { resolvePlanWithUuid } from '../assignments/uuid_lookup.js';

type PlanWithFilename = PlanSchema & { filename: string };

const MIN_TIMESTAMP = Number.NEGATIVE_INFINITY;

function parseIsoTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

async function getPlanTimestamp(plan: PlanWithFilename): Promise<number> {
  const updatedAt = parseIsoTimestamp(plan.updatedAt);
  if (updatedAt !== undefined) {
    return updatedAt;
  }

  const createdAt = parseIsoTimestamp(plan.createdAt);
  if (createdAt !== undefined) {
    return createdAt;
  }

  try {
    const fileStats = await fs.stat(plan.filename);
    return fileStats.mtimeMs;
  } catch {
    return MIN_TIMESTAMP;
  }
}

async function findMostRecentlyUpdatedPlan<T extends PlanWithFilename>(
  plans: Map<number, T>
): Promise<T | null> {
  let latestPlan: T | null = null;
  let latestTimestamp = MIN_TIMESTAMP;

  for (const candidate of plans.values()) {
    const timestamp = await getPlanTimestamp(candidate);
    if (timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
      latestPlan = candidate;
    }
  }

  return latestPlan;
}

/**
 * Creates a stub plan YAML file with the given plan text in the details field
 * @param planText The plan text to store in the details field
 * @param config The effective configuration
 * @param title Optional title for the plan (will be extracted from planText if not provided)
 * @param issueUrls Optional array of issue URLs to include in the plan
 * @returns Object containing the created plan data and file path
 */
async function createStubPlanFromText(
  planText: string,
  config: any,
  paths: { tasksDir: string },
  title?: string,
  issueUrls?: string[]
): Promise<{ data: PlanSchema; path: string }> {
  const targetDir = paths.tasksDir;

  // Ensure the target directory exists (resolvePlanPathContext already does this but keeping guard)
  await fs.mkdir(targetDir, { recursive: true });

  // Generate a unique numeric plan ID
  const planId = await generateNumericPlanId(targetDir);

  // Extract title from plan text if not provided
  let planTitle = title;
  if (!planTitle) {
    // Try to extract title from first line if it starts with #
    const firstLine = planText.split('\n')[0];
    if (firstLine.startsWith('#')) {
      planTitle = firstLine.replace(/^#+\s*/, '').trim();
    } else {
      // Generate a title from the first few words
      const words = planText.split(/\s+/).slice(0, 8);
      planTitle = words
        .join(' ')
        .replace(/[^\w\s-]/g, '')
        .trim();
    }
  }

  // Create filename using plan ID + slugified title
  const slugifiedTitle = slugify(planTitle);
  const filename = `${planId}-${slugifiedTitle}.plan.md`;

  // Construct the full path to the new plan file
  const filePath = path.join(targetDir, filename);

  // Create the initial plan object adhering to PlanSchema
  const plan: PlanSchema = {
    id: planId,
    uuid: crypto.randomUUID(),
    title: planTitle,
    goal: '',
    details: planText,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
  };

  // Add issue URLs if provided
  if (issueUrls && issueUrls.length > 0) {
    plan.issue = issueUrls;
  }

  // Write the plan to the new file
  await writePlanFile(filePath, plan);

  log(chalk.green('✓ Created plan stub:'), filePath, 'for ID', chalk.green(planId));

  return { data: plan, path: filePath };
}

export async function handleGenerateCommand(
  planArg: string | undefined,
  options: any,
  command: any
) {
  // Available options:
  // - plan: Plan to use
  // - planEditor: Open plan in editor
  // - issue: Issue URL or number to use for the plan text
  // - simple: Generate a single-phase plan
  // - autofind: Automatically find relevant files
  // - quiet: Suppress informational output
  // - extract: Run extract command after generating (default true)
  // - commit: Commit changes after successful plan generation
  // - useYaml: Skip generation and use existing YAML file
  // - direct: Call LLM directly instead of copying to clipboard
  // - claude: Use Claude Code for two-step planning and generation
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const pathContext = await resolvePlanPathContext(config);
  const { gitRoot, tasksDir: tasksDirectory } = pathContext;

  // Determine effective direct mode setting with precedence:
  // 1. Command-line flag (--direct or --no-direct)
  // 2. Config setting (config.planning?.direct_mode)
  // 3. Default to false
  const effectiveDirectMode =
    options.direct !== undefined ? options.direct : (config.planning?.direct_mode ?? false);

  // Determine effective Claude mode setting with precedence:
  // 1. Command-line flag (--claude or --no-claude)
  // 2. Config setting (config.planning?.claude_mode)
  // 3. Default to true (making Claude mode the default)
  const effectiveClaudeMode =
    options.claude !== undefined ? options.claude : (config.planning?.claude_mode ?? true);

  // Find '--' in process.argv to get extra args for rmfilter
  const doubleDashIdx = process.argv.indexOf('--');
  const userCliRmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];

  if (userCliRmfilterArgs[0] === planArg) {
    planArg = undefined;
  }

  // Validate input options first
  let planOptionsSet = [
    planArg,
    options.plan,
    options.planEditor,
    options.issue,
    options.nextReady,
    options.latest,
  ].reduce((acc, val) => acc + (val ? 1 : 0), 0);

  // Manual conflict check for --plan, --plan-editor, --issue, and --next-ready
  if (planOptionsSet !== 1) {
    throw new Error(
      'You must provide one and only one of [plan], --plan <plan>, --plan-editor, --issue <url|number>, --next-ready <planIdOrPath>, or --latest'
    );
  }

  // Handle --next-ready option - find and operate on next ready dependency
  if (options.nextReady) {
    const tasksDir = tasksDirectory;
    // Convert string ID to number or resolve plan file to get numeric ID
    let parentPlanId: number;
    const planIdNumber = parseInt(options.nextReady, 10);
    if (!isNaN(planIdNumber)) {
      parentPlanId = planIdNumber;
    } else {
      // Try to resolve as a file path and get the plan ID
      const planFile = await resolvePlanFile(options.nextReady, globalOpts.config);
      const plan = await readPlanFile(planFile);
      if (!plan.id) {
        throw new Error(`Plan file ${planFile} does not have a valid ID`);
      }
      parentPlanId = plan.id;
    }

    const result = await findNextReadyDependency(parentPlanId, tasksDir, true);

    if (!result.plan) {
      log(result.message);
      return;
    }

    log(chalk.green(`Found ready plan: ${result.plan.id} - ${result.plan.title}`));

    // Set the resolved plan as the target
    options.plan = result.plan.filename;
    planArg = undefined; // Clear planArg since we're using options.plan
  } else if (options.latest) {
    const { plans } = await readAllPlans(tasksDirectory);

    if (plans.size === 0) {
      log('No plans found in tasks directory.');
      return;
    }

    const latestPlan = await findMostRecentlyUpdatedPlan(plans);

    if (!latestPlan) {
      log('No plans found in tasks directory.');
      return;
    }

    const title = getCombinedTitle(latestPlan);
    const label =
      latestPlan.id !== undefined && latestPlan.id !== null
        ? `${latestPlan.id} - ${title}`
        : title || latestPlan.filename;

    log(chalk.green(`Found latest plan: ${label}`));

    options.plan = latestPlan.filename;
    planArg = undefined;
  }

  // Handle --use-yaml option which skips generation and uses the file as if it was pasted
  if (options.useYaml) {
    const yamlContent = await Bun.file(options.useYaml).text();

    // Determine output path based on plan argument or generate default
    let outputPath: string;
    let stubPlan: { data: PlanSchema; path: string } | undefined;
    if (planArg || options.plan) {
      const planFile = await resolvePlanFile(planArg || options.plan, globalOpts.config);
      outputPath = planFile;
      stubPlan = {
        data: await readPlanFile(planFile),
        path: planFile,
      };
    } else {
      outputPath = 'rmplan-output';
    }

    // Process the YAML as if it was pasted by the user
    const extractOptions: ExtractMarkdownToYamlOptions = {
      output: outputPath,
      planRmfilterArgs: userCliRmfilterArgs,
      issueUrls: [],
      commit: options.commit,
      stubPlan,
      generatedBy: 'oneshot',
    };

    await extractMarkdownToYaml(yamlContent, config, options.quiet ?? false, extractOptions);
    return;
  }

  if (planArg) {
    options.plan = planArg;
  }

  let planText: string | undefined;
  let combinedRmprOptions: RmprOptions | null = null;
  let issueResult: IssueInstructionData | undefined;
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

      // Check if plan is already done
      if (parsedPlan.status === 'done') {
        warn(
          chalk.yellow(
            '⚠️  Warning: This plan is already marked as "done". You may have typed the wrong plan ID.'
          )
        );
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

      // Create stub plan file with the plan text in details
      const stubPlanResult = await createStubPlanFromText(planText, config, pathContext);
      planFile = stubPlanResult.path;
      parsedPlan = stubPlanResult.data;
    } catch (err) {
      throw new Error(`Failed to get plan from editor: ${err as Error}`);
    }
  } else if (options.issue) {
    // Get the issue tracker client
    const issueTracker = await getIssueTracker(config);

    // Use the generic issue utilities
    issueResult = await getInstructionsFromIssue(issueTracker, options.issue);
    planText = issueResult.plan;
    // Extract combinedRmprOptions from the result if it exists
    combinedRmprOptions = issueResult.rmprOptions ?? null;

    // Construct the issue URL
    issueUrlsForExtract.push(issueResult.issue.html_url);

    // Create stub plan file with the issue text in details
    const stubPlanResult = await createStubPlanFromText(planText, config, pathContext, undefined, [
      issueResult.issue.html_url,
    ]);
    planFile = stubPlanResult.path;
    parsedPlan = stubPlanResult.data;
  }

  // Special handling for stub YAML plans
  let stubPlan: { data: PlanSchema; path: string } | undefined;
  if (parsedPlan && planFile) {
    // Set up stub plan for use in the rest of the flow
    stubPlan = { data: parsedPlan, path: planFile };

    // Check if plan has simple field set and respect it
    // CLI flags take precedence: explicit --simple or --no-simple override plan field
    const hasExplicitSimpleFlag = 'simple' in options && options.simple !== undefined;
    if (!hasExplicitSimpleFlag && parsedPlan.simple === true) {
      options.simple = true;
    }

    // Check if this is a stub plan that was loaded from existing file (not created by us)
    const wasCreatedByUs = options.planEditor || options.issue;

    if (!wasCreatedByUs) {
      // This is an existing stub plan file, process it normally
      const { goal, details } = stubPlan.data;

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
        const { plans: allPlans } = await readAllPlans(tasksDirectory);
        const parentPlan = allPlans.get(stubPlan.data.parent);
        if (parentPlan) {
          planParts.push(
            `\n# Parent Plan Context`,
            `\nThe parent plan details give you more context about the larger project around this plan. It may be useful to reference these details when working on this plan, but keep in mind that some of these details may already be implemented, so look at the actual code to verify what needs to be done.\n`,
            `**Parent Plan:** ${parentPlan.title || `Plan ${stubPlan.data.parent}`} (ID: ${stubPlan.data.parent})`
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
    } else {
      // This was created by us, planText is already set correctly
      log(chalk.blue('🔄 Created stub plan. Generating detailed tasks for:'), planFile);
    }
  }

  if (!planText) {
    throw new Error('No plan text was provided.');
  }

  // Read planning document if configured
  let planningDocContent = '';
  if (config.planning?.instructions) {
    const planningPath = path.isAbsolute(config.planning.instructions)
      ? config.planning.instructions
      : path.join(gitRoot, config.planning.instructions);
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

  let exitRes: number | undefined;
  let rmfilterOutputPath: string | undefined;
  let tmpPromptPath: string | undefined;
  let wrotePrompt = false;
  let allRmfilterOptions: string[] = [];

  // Handle Claude mode separately - no rmfilter needed
  if (effectiveClaudeMode) {
    exitRes = 0; // Skip all rmfilter logic
    // For Claude mode, we still need to collect rmfilter options for the extract phase
    // Process the combinedRmprOptions if available
    let issueRmfilterOptions: string[] = [];
    if (combinedRmprOptions) {
      issueRmfilterOptions = argsFromRmprOptions(combinedRmprOptions);
    }

    // Combine user CLI args and issue rmpr options
    for (const argList of [userCliRmfilterArgs, issueRmfilterOptions, stubPlan?.data?.rmfilter]) {
      if (!argList?.length) continue;
      // Add a separator if some options already exist
      if (allRmfilterOptions.length) allRmfilterOptions.push('--');
      allRmfilterOptions.push(...argList.flatMap((arg) => arg.split(' ')));
    }
  } else {
    // Traditional mode - set up temp files and run rmfilter
    const tmpDir = os.tmpdir();
    tmpPromptPath = path.join(tmpDir, `rmplan-prompt-${Date.now()}.md`);
    rmfilterOutputPath = path.join(tmpDir, `rmfilter-output-${Date.now()}.xml`);

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
      for (const argList of [userCliRmfilterArgs, issueRmfilterOptions, stubPlan?.data?.rmfilter]) {
        if (!argList?.length) continue;
        // Add a separator if some options already exist
        if (allRmfilterOptions.length) allRmfilterOptions.push('--');
        allRmfilterOptions.push(...argList.flatMap((arg) => arg.split(' ')));
      }

      // Check if no files are provided to rmfilter
      const hasNoFiles = additionalFiles.length === 0 && allRmfilterOptions.length === 0;

      if (hasNoFiles) {
        warn(
          chalk.yellow(
            '\n⚠️  Warning: No files specified for rmfilter. The prompt will only contain the planning instructions without any code context.'
          )
        );

        // Warn if copying content for a plan that's already done or has tasks
        if (
          parsedPlan &&
          (parsedPlan.status === 'done' || (parsedPlan.tasks && parsedPlan.tasks.length > 0))
        ) {
          warn(
            chalk.yellow(
              '⚠️  Warning: Copying content for a plan that is already done or has existing tasks. You may have typed the wrong plan ID.'
            )
          );
        }

        if (!effectiveDirectMode) {
          // Copy the prompt directly to clipboard without running rmfilter
          await clipboard.write(promptString);
          log('Prompt copied to clipboard');
        }
        exitRes = 0;
      } else {
        // Collect docs from stub plan
        const docsArgs: string[] = [];
        if (stubPlan?.data?.docs) {
          stubPlan?.data.docs.forEach((doc) => {
            if (!isURL(doc)) {
              docsArgs.push('--docs', doc);
            }
          });
        }

        // Warn if copying content for a plan that's already done or has tasks
        if (
          parsedPlan &&
          (parsedPlan.status === 'done' || (parsedPlan.tasks && parsedPlan.tasks.length > 0))
        ) {
          warn(
            chalk.yellow(
              '⚠️  Warning: Copying content for a plan that is already done or has existing tasks. You may have typed the wrong plan ID.'
            )
          );
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
          '--output',
          rmfilterOutputPath,
        ];
        const proc = logSpawn(rmfilterFullArgs, {
          cwd: gitRoot,
          stdio: ['inherit', 'inherit', 'inherit'],
        });
        exitRes = await proc.exited;
      }
    } catch (err) {
      // Handle errors in traditional mode
      exitRes = 1;
      throw err;
    }
  }

  try {
    if (exitRes === 0 && options.extract !== false) {
      let researchToPersist: { content: string; insertedAt: Date } | undefined;
      let input: string;

      if (effectiveClaudeMode) {
        // Generate the prompts for Claude Code
        // For simple mode: skip research and don't pass planText to generation
        const planningPrompt = options.simple
          ? generateClaudeCodeSimplePlanningPrompt(fullPlanText)
          : generateClaudeCodePlanningPrompt(fullPlanText);

        const generationPrompt = options.simple
          ? generateClaudeCodeGenerationPrompt('')
          : generateClaudeCodeGenerationPrompt(fullPlanText);

        // Only include research prompt for non-simple mode
        const researchPrompt = options.simple ? undefined : generateClaudeCodeResearchPrompt();

        // Use the shared Claude Code invocation helper
        const claudeResult = await invokeClaudeCodeForGeneration(planningPrompt, generationPrompt, {
          model: config.models?.stepGeneration,
          includeDefaultTools: true,
          researchPrompt,
        });

        if (claudeResult.researchOutput?.trim()) {
          if (planFile) {
            researchToPersist = {
              content: claudeResult.researchOutput,
              insertedAt: new Date(),
            };
            log(chalk.green('✓ Captured research findings for plan details'));
          } else {
            warn('Generated research findings but no plan file was available to update.');
          }
        }

        input = claudeResult.generationOutput;
      } else if (effectiveDirectMode) {
        // Direct LLM call
        const modelId = config.models?.stepGeneration || DEFAULT_RUN_MODEL;
        const model = await createModel(modelId, config);

        if (!rmfilterOutputPath) {
          throw new Error('rmfilterOutputPath not available for direct mode');
        }

        const rmfilterOutput = await Bun.file(rmfilterOutputPath).text();

        log('Generating plan using model:', modelId);

        const result = await runStreamingPrompt({
          model,
          messages: [
            {
              role: 'user',
              content: rmfilterOutput,
            },
          ],
          temperature: 0.1,
        });
        input = result.text;
      } else {
        // Original clipboard/paste mode
        log(
          chalk.bold(
            `\nPlease paste the prompt into the chat interface. Then ${sshAwarePasteAction()} to extract the copied Markdown to a YAML plan file, or Ctrl+C to exit.`
          )
        );

        input = await waitForEnter(true);
      }

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
        generatedBy: effectiveClaudeMode ? 'agent' : 'oneshot',
        researchContent: researchToPersist?.content,
      };

      await extractMarkdownToYaml(input, config, options.quiet ?? false, extractOptions);

      const targetPlanArg = planFile ?? outputPath;
      if (targetPlanArg && isAutoClaimEnabled()) {
        try {
          const { plan, uuid } = await resolvePlanWithUuid(targetPlanArg, {
            configPath: globalOpts.config,
          });
          await autoClaimPlan({ plan, uuid }, { cwdForIdentity: gitRoot });
        } catch (err) {
          warn(`Failed to auto-claim plan ${targetPlanArg}: ${err as Error}`);
        }
      }
    }
  } finally {
    if (wrotePrompt && tmpPromptPath) {
      try {
        await fs.rm(tmpPromptPath);
      } catch (e) {
        warn('Warning: failed to clean up temp file:', tmpPromptPath);
      }
    }

    if (rmfilterOutputPath) {
      try {
        await fs.rm(rmfilterOutputPath);
      } catch (e) {
        warn('Warning: failed to clean up temp file:', rmfilterOutputPath);
      }
    }
  }

  if (exitRes !== 0) {
    throw new Error(`rmfilter exited with code ${exitRes}`);
  }
}
