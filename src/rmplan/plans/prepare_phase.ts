import chalk from 'chalk';
import path from 'path';
import * as clipboard from '../../common/clipboard.js';
import { getGitRoot } from '../../common/git.js';
import { createModel } from '../../common/model_factory.js';
import { sshAwarePasteAction } from '../../common/ssh_detection.js';
import { waitForEnter } from '../../common/terminal.js';
import { error, log, warn } from '../../logging.js';
import type { PlanSchema } from '../planSchema.js';
import { findYamlStart } from '../process_markdown.js';
import type { PhaseGenerationContext } from '../prompt.js';
import { generatePhaseStepsPrompt } from '../prompt.js';
import { runRmfilterProgrammatically } from '../../rmfilter/rmfilter.js';
import { type RmplanConfig } from '../configSchema.js';
import { findSiblingPlans, isURL } from '../context_helpers.js';
import { fixYaml } from '../fix_yaml.js';
import { DEFAULT_RUN_MODEL, runStreamingPrompt } from '../llm_utils/run_and_apply.js';
import { readAllPlans, readPlanFile, writePlanFile } from '../plans.js';

/**
 * Prepares a phase by generating detailed implementation steps and prompts for all tasks.
 * This function represents a key integration point in the refactored architecture, combining:
 *
 * - Plan file management through the centralized plans.js utilities
 * - Dependency analysis and validation across phase relationships
 * - Context gathering using rmfilter programmatic interface
 * - LLM integration through the executor system or direct API calls
 * - Git operations through src/common/git.ts for repository management
 * - Clipboard operations through src/common/clipboard.ts for workflow management
 *
 * The function orchestrates the complex workflow of converting high-level phase descriptions
 * into detailed, executable implementation steps by gathering context about previous phases,
 * changed files, and project structure.
 *
 * @param phaseYamlFile - Path to the phase YAML file to prepare with detailed steps
 * @param config - RmplanConfig instance with user preferences and model settings
 * @param options - Configuration options for forcing preparation, model selection, and execution mode
 * @returns Promise that resolves when phase preparation is complete
 * @throws {Error} When dependencies are incomplete, context gathering fails, or LLM execution errors
 */
export async function preparePhase(
  phaseYamlFile: string,
  config: RmplanConfig,
  options: {
    force?: boolean;
    model?: string;
    rmfilterArgs?: string[];
    direct?: boolean;
    useYaml?: string;
  } = {}
): Promise<void> {
  try {
    // Load the target phase YAML file
    const currentPhaseData = await readPlanFile(phaseYamlFile);
    const projectPlanDir = path.dirname(phaseYamlFile);
    const { plans: allPlans } = await readAllPlans(projectPlanDir);

    // Dependency Checking
    if (currentPhaseData.dependencies && currentPhaseData.dependencies.length > 0) {
      for (const dependencyId of currentPhaseData.dependencies) {
        const dependencyPlan = allPlans.get(dependencyId);

        if (!dependencyPlan) {
          warn(`Warning: Could not find dependency ${dependencyId} in project directory`);
          if (!options.force) {
            throw new Error(
              'Cannot proceed without checking all dependencies. Use --force to override.'
            );
          }
          continue;
        }

        if (dependencyPlan.status !== 'done') {
          const msg = `Dependency ${dependencyId} is not complete (status: ${dependencyPlan.status}).`;
          warn(msg);

          if (!options.force) {
            throw new Error(
              'Cannot proceed without completed dependencies. Use --force to override.'
            );
          }

          warn('Proceeding despite incomplete dependencies due to --force flag.');
        }
      }
    }

    // Call gatherPhaseGenerationContext
    let phaseGenCtx = await gatherPhaseGenerationContext(
      phaseYamlFile,
      projectPlanDir,
      allPlans,
      options.rmfilterArgs
    );

    // Prepare rmfilter arguments for codebase context
    const rmfilterArgs = [...phaseGenCtx.rmfilterArgsFromPlan];

    // Add files from tasks if any are pre-populated
    for (const task of currentPhaseData.tasks) {
      if (task.files && task.files.length > 0) {
        rmfilterArgs.push(...task.files);
      }
    }

    // Collect docs from phase and tasks only (config paths are handled elsewhere)
    const docsSet = new Set<string>();

    // Add docs from the current phase
    if (currentPhaseData.docs) {
      currentPhaseData.docs.forEach((doc: string) => {
        docsSet.add(doc);
      });
    }

    // Add docs from tasks
    for (const task of currentPhaseData.tasks) {
      if (task.docs) {
        task.docs.forEach((doc: string) => {
          docsSet.add(doc);
        });
      }
    }

    // Convert to array and create --docs arguments
    const docs = Array.from(docsSet);
    const docsArgs = docs.filter((doc) => !isURL(doc)).flatMap((doc) => ['--docs', doc]);

    // Read planning document if configured
    let planningDocContent = '';
    const gitRoot = (await getGitRoot()) || process.cwd();
    if (config.paths?.planning) {
      const planningPath = path.isAbsolute(config.paths.planning)
        ? config.paths.planning
        : path.join(gitRoot, config.paths.planning);
      const planningFile = Bun.file(planningPath);
      planningDocContent = await planningFile.text();
      log(chalk.blue('📋 Including planning document:'), path.relative(gitRoot, planningPath));
    }

    let phaseStepsPrompt = generatePhaseStepsPrompt(phaseGenCtx);

    // Add planning document content to the prompt if available
    if (planningDocContent) {
      phaseStepsPrompt += `\n\n## Planning Rules\n\n${planningDocContent}`;
    }

    // 6. Invoke rmfilter programmatically
    let prompt: string;
    try {
      prompt = await runRmfilterProgrammatically(
        [...rmfilterArgs, ...docsArgs, '--bare', '--instructions', phaseStepsPrompt],
        gitRoot,
        gitRoot
      );
    } catch (err) {
      error('Failed to execute rmfilter:', err);
      throw err;
    }

    // 7. Call LLM or use clipboard/paste mode
    let text: string;

    if (options.useYaml) {
      // Use provided YAML file as LLM output
      text = await Bun.file(options.useYaml).text();
      log(chalk.green('✓ Using YAML from file:'), options.useYaml);
    } else if (options.direct) {
      // Direct LLM call
      const modelId = options.model || config.models?.stepGeneration || DEFAULT_RUN_MODEL;
      const model = await createModel(modelId, config);

      log('Generating detailed steps for phase using model:', modelId);

      const result = await runStreamingPrompt({
        model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2,
      });
      text = result.text;
    } else {
      // Clipboard/paste mode
      await clipboard.write(prompt);
      log(chalk.green('✓ Phase preparation prompt copied to clipboard'));
      log(
        chalk.bold(
          `\nPlease paste the prompt into the chat interface. Then ${sshAwarePasteAction()} with the detailed steps, or Ctrl+C to exit.`
        )
      );

      text = await waitForEnter(true);

      if (!text || !text.trim()) {
        throw new Error('No response was pasted.');
      }
    }

    // 9. Parse LLM Output
    let parsedTasks;
    try {
      // Extract YAML from the response (LLM might include markdown formatting)
      const yamlContent = findYamlStart(text);
      const parsed = await fixYaml(yamlContent, 5, config);

      // Validate that we got a tasks array
      if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
        throw new Error('LLM output does not contain a valid tasks array');
      }

      parsedTasks = parsed.tasks;
    } catch (err) {
      // Save raw LLM output for debugging
      const errorFilePath = phaseYamlFile
        .replace('.yaml', '.llm_error.txt')
        .replace('.md', '.llm_error.txt');

      try {
        await Bun.write(errorFilePath, text);
        error('Failed to parse LLM output. Raw output saved to:', errorFilePath);
      } catch (saveErr) {
        error('Failed to save error files:', saveErr);
      }

      error('Parse error:', err);
      error('Please manually correct the LLM output or retry with a different model');
      throw err;
    }

    // 10. Update Phase YAML
    currentPhaseData.tasks = parsedTasks;

    // Update timestamps
    const now = new Date().toISOString();
    currentPhaseData.promptsGeneratedAt = now;
    currentPhaseData.updatedAt = now;

    // 11. Write the updated phase YAML back to file
    await writePlanFile(phaseYamlFile, currentPhaseData);

    // 12. Log success
    log(chalk.green('✓ Successfully generated detailed steps for phase'));
    let relativePath = path.relative(gitRoot, phaseYamlFile);
    log(`Updated phase file: ${relativePath}`);
  } catch (err) {
    error('Failed to generate phase details:', err);
    throw err;
  }
}

/**
 * Gathers all necessary context for generating detailed implementation steps for a phase.
 * @param phaseFilePath Path to the phase YAML file to generate steps for
 * @param projectPlanDir Directory containing all phase YAML files
 * @returns Context object containing all information needed for phase step generation
 */
async function gatherPhaseGenerationContext(
  phaseFilePath: string,
  projectPlanDir: string,
  allPlans: Map<number, PlanSchema & { filename: string }>,
  rmfilterArgs?: string[]
): Promise<PhaseGenerationContext> {
  try {
    // 1. Load and validate the target phase YAML file
    const currentPhaseData = await readPlanFile(phaseFilePath);

    // 2. Determine the overall project plan's goal and details
    let overallProjectGoal = '';
    let overallProjectDetails = '';
    let overallProjectTitle = '';

    // Check if the phase has project-level fields
    if (currentPhaseData.project) {
      overallProjectGoal = currentPhaseData.project.goal;
      overallProjectDetails = currentPhaseData.project.details;
      overallProjectTitle = currentPhaseData.project.title;
    }

    // 3. Initialize arrays for previous phases info and changed files
    const previousPhasesInfo: Array<{
      id: number;
      title: string;
      goal: string;
      description: string;
    }> = [];
    const changedFilesFromDependencies: string[] = [];

    // 4. Process parent plan info
    let parentPlanInfo:
      | { id: number; title: string; goal: string; details: string; docURLs?: string[] }
      | undefined;
    if (currentPhaseData.parent) {
      const parentPlan = allPlans.get(currentPhaseData.parent);
      if (parentPlan) {
        const parentDocURLs = parentPlan.docs?.filter(isURL) || [];
        parentPlanInfo = {
          id: currentPhaseData.parent,
          title: parentPlan.title || `Plan ${currentPhaseData.parent}`,
          goal: parentPlan.goal,
          details: parentPlan.details || '',
          ...(parentDocURLs.length > 0 && { docURLs: parentDocURLs }),
        };
      }
    }

    // 5. Process each dependency
    if (currentPhaseData.dependencies && currentPhaseData.dependencies.length > 0) {
      // Read all plans in the directory to find dependencies by ID
      const { plans: allPlans } = await readAllPlans(projectPlanDir);

      for (const dependencyId of currentPhaseData.dependencies) {
        const dependencyPlan = allPlans.get(dependencyId);

        if (!dependencyPlan) {
          throw new Error(
            `Dependency phase with ID '${dependencyId}' not found in project directory`
          );
        }

        // Check if dependency is done
        if (dependencyPlan.status !== 'done') {
          throw new Error(
            `Dependency ${dependencyId} is not completed (status: ${dependencyPlan.status}). All dependencies must be completed before generating phase steps.`
          );
        }

        // Extract title from details or use ID as fallback
        const title = dependencyPlan.details?.split('\n')[0] || `Phase ${dependencyId}`;

        previousPhasesInfo.push({
          id: dependencyPlan.id || dependencyId,
          title: title,
          goal: dependencyPlan.goal,
          description: dependencyPlan.details || '',
        });

        // Add changed files from this dependency
        if (dependencyPlan.changedFiles && dependencyPlan.changedFiles.length > 0) {
          changedFilesFromDependencies.push(...dependencyPlan.changedFiles);
        }
      }
    }

    // Deduplicate changed files
    const uniqueChangedFiles = Array.from(new Set(changedFilesFromDependencies));

    const changedFilesExist = (
      await Promise.all(
        uniqueChangedFiles.map(async (file) => {
          try {
            if (await Bun.file(file).exists()) {
              return file;
            }
            return false;
          } catch (err) {
            return false;
          }
        })
      )
    ).filter(Boolean) as string[];

    const rmfilterArgsFromPlan = [...(currentPhaseData.rmfilter || []), ...(rmfilterArgs || [])];

    if (changedFilesExist.length > 0) {
      rmfilterArgsFromPlan.push('--', ...changedFilesExist);
    }

    // Extract current phase doc URLs
    const currentPhaseDocURLs = currentPhaseData.docs?.filter(isURL) || [];

    // Get sibling plans if there's a parent
    let siblingPlansInfo: PhaseGenerationContext['siblingPlansInfo'];
    if (currentPhaseData.parent) {
      try {
        const siblings = await findSiblingPlans(
          currentPhaseData.id || 0,
          currentPhaseData.parent,
          projectPlanDir
        );
        if (siblings.completed.length > 0 || siblings.pending.length > 0) {
          siblingPlansInfo = siblings;
        }
      } catch (err) {
        warn(`Warning: Could not load sibling plans: ${err as Error}`);
      }
    }

    // 5. Build and return the context object
    const context: PhaseGenerationContext = {
      overallProjectGoal,
      overallProjectDetails,
      overallProjectTitle: overallProjectTitle || undefined,
      currentPhaseTitle: currentPhaseData.title,
      currentPhaseGoal: currentPhaseData.goal,
      currentPhaseDetails: currentPhaseData.details || '',
      currentPhaseTasks: currentPhaseData.tasks.map((task) => ({
        title: task.title,
        description: task.description,
      })),
      previousPhasesInfo,
      parentPlanInfo,
      ...(siblingPlansInfo && { siblingPlansInfo }),
      changedFilesFromDependencies: changedFilesExist,
      rmfilterArgsFromPlan,
      ...(currentPhaseDocURLs.length > 0 && { currentPhaseDocURLs }),
      currentPlanFilename: path.basename(phaseFilePath),
    };

    return context;
  } catch (e) {
    if (e instanceof Error) {
      error(`Error gathering phase generation context: ${e.message}`);
    } else {
      error(`Error gathering phase generation context: ${String(e)}`);
    }
    throw e;
  }
}
