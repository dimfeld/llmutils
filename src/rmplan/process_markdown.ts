import { streamText } from 'ai';
import chalk from 'chalk';
import yaml from 'yaml';
import { getGitRoot } from '../common/git.js';
import { createModel } from '../common/model_factory.js';
import { commitAll } from '../common/process.js';
import { boldMarkdownHeaders, debugLog, error, log, warn } from '../logging.js';
import { resolveTasksDir, rmplanConfigSchema, type RmplanConfig } from './configSchema.js';
import { fixYaml } from './fix_yaml.js';
import { generateNumericPlanId } from './id_utils.js';
import type { PlanSchema } from './planSchema.js';
import { phaseSchema, planSchema } from './planSchema.js';
import { isTaskDone, writePlanFile } from './plans.js';
import { phaseExampleFormatGeneric, planExampleFormatGeneric } from './prompt.js';
import { appendResearchToPlan } from './research_utils.ts';
// Note: previously used for prompting on multiphase directory names.
// No longer needed since we always write a single plan file.
import type { GoogleGenerativeAIProviderOptions } from '@ai-sdk/google';

export function convertYamlToMarkdown(
  plan: PlanSchema,
  options?: { includeTaskIds?: boolean }
): string {
  const sections: string[] = [];

  // Title section (if present)
  if (plan.title) {
    sections.push(`# ${plan.title}`);
  }

  // Goal section
  sections.push(`## Goal\n${plan.goal}`);

  // Priority section (if present)
  if (plan.priority) {
    sections.push(`## Priority\n${plan.priority}`);
  }

  // Details section
  if (plan.details) {
    sections.push(`### Details\n${plan.details}`);
  }

  // Add separator
  sections.push('---');

  // Separate tasks into done and pending
  const doneTasks: Array<{ task: PlanSchema['tasks'][0]; index: number }> = [];
  const pendingTasks: Array<{ task: PlanSchema['tasks'][0]; index: number }> = [];

  plan.tasks.forEach((task, index) => {
    // Check if all steps in the task are done
    if (isTaskDone(task)) {
      doneTasks.push({ task, index });
    } else {
      pendingTasks.push({ task, index });
    }
  });

  // Add done tasks section if there are any
  if (doneTasks.length > 0) {
    sections.push('# Completed Tasks');
    sections.push('*These tasks have been completed and should not be modified.*');
    sections.push('');

    for (const { task, index } of doneTasks) {
      const taskSections: string[] = [];

      // Task title with ID
      const taskId = options?.includeTaskIds ? ` [TASK-${index + 1}]` : '';
      taskSections.push(`## Task: ${task.title}${taskId} ✓`);

      // Task description
      taskSections.push(`**Description:** ${task.description}`);

      sections.push(taskSections.join('\n'));
      sections.push('---');
    }
  }

  // Add pending tasks section
  if (pendingTasks.length > 0) {
    if (doneTasks.length > 0) {
      sections.push('# Pending Tasks');
      sections.push('*These tasks can be updated, modified, or removed as needed.*');
      sections.push('');
    }

    for (const { task, index } of pendingTasks) {
      const taskSections: string[] = [];

      // Task title with ID
      const taskId = options?.includeTaskIds ? ` [TASK-${index + 1}]` : '';
      taskSections.push(`## Task: ${task.title}${taskId}`);

      // Task description
      taskSections.push(`**Description:** ${task.description}`);

      sections.push(taskSections.join('\n'));
      sections.push('---');
    }
  }

  // Remove the last separator if there were tasks
  if (plan.tasks.length > 0) {
    sections.pop();
  }

  return sections.join('\n\n');
}

// Define the prompt for Markdown to YAML conversion
const markdownToYamlConversionPrompt = `You are an AI assistant specialized in converting structured Markdown text into YAML format. Your task is to convert the provided Markdown input into YAML, strictly adhering to the specified schema.

**Input Markdown:**

Here is the text that needs to be converted to valid YAML:

<input_text>
{markdownInput}
</input_text>

**Instructions:**

1.  **Detect the format:** First, determine if this is a multi-phase plan or a single-phase plan.
    - Multi-phase plans contain sections like "### Phase 1:", "### Phase 2:" etc.
    - Single-phase plans do not have phase sections

2.  **Convert based on format:**

    **For SINGLE-PHASE plans**, use this schema:
    \`\`\`yaml
${planExampleFormatGeneric}
    \`\`\`

    **For MULTI-PHASE plans**, use this schema:
    \`\`\`yaml
${phaseExampleFormatGeneric}
    \`\`\`

3.  **Handle phase dependencies:** For multi-phase plans, convert dependency references like "Phase 1, Phase 2" to phase IDs in format "project-1", "project-2" etc. Use "project" as the default project prefix.

4.  **Handle Markdown lists:** Convert Markdown lists appropriately into YAML sequences.

5.  **Handle Multi-line Strings:** For step prompts, use the YAML pipe character | for multi-line strings.

6.  **Indentation:** Use exactly 2 spaces for YAML indentation levels.

7.  **String quoting:** Use quotes for YAML strings when necessary. Single-line strings containing colons always need to be quoted.

8.  **Output Format:** Output *only* the raw, valid YAML string. Do **not** include any introductory text, explanations, comments, or Markdown fences (like \`\`\`yaml or \`\`\`).

9. String with colons MUST be quoted.

10. Multi-line strings MUST be properly indented.

11. Phase details should include everything under the details header and subheader. Generally this is everyfrom from the Details header up to the Tasks header.

**Important for multi-phase plans:**
- Each phase should have an id like "project-1", "project-2" etc.
`;

export async function convertMarkdownToYaml(
  markdownInput: string,
  config: RmplanConfig,
  quiet = false
): Promise<string> {
  const modelSpec = config.models?.convert_yaml || 'google/gemini-2.5-flash-preview-05-20';
  const prompt = markdownToYamlConversionPrompt.replace('{markdownInput}', markdownInput);
  let result = streamText({
    model: await createModel(modelSpec, config),
    prompt,
    temperature: 0,
    providerOptions: {
      google: {
        thinkingConfig: {
          thinkingBudget: 0,
        },
      } satisfies GoogleGenerativeAIProviderOptions,
    },
  });

  if (!quiet) {
    for await (const chunk of result.fullStream) {
      if (chunk.type === 'text-delta') {
        process.stdout.write(chunk.textDelta);
      } else if (chunk.type === 'error') {
        throw new Error((chunk.error as any).toString());
      }
    }
    process.stdout.write('\n');
  }

  return findYamlStart(await result.text);
}

export function findYamlStart(text: string): string {
  // Clean up the output
  text = text.trim();

  // Remove potential Markdown fences
  if (text.startsWith('```yaml') && text.endsWith('```')) {
    text = text.slice(7, -3).trim();
  } else if (text.startsWith('```') && text.endsWith('```')) {
    // Handle generic fences just in case
    text = text.slice(3, -3).trim();
  }

  // Look for the first line that looks like a YAML key
  // A YAML key typically starts with a word character, contains alphanumeric/underscores/hyphens,
  // and ends with a colon (potentially followed by whitespace or a value)
  const lines = text.split('\n');
  let startIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Match a line that looks like a YAML key: starts with a letter, followed by word chars/hyphens, then colon
    const m = /^(- )?([a-zA-Z][a-zA-Z0-9_-]*):/.exec(line);
    if (m && Object.keys(rmplanConfigSchema.shape).includes(m[2])) {
      startIndex = text.indexOf(lines[i]);
      break;
    }
  }

  // Remove potential introductory lines before the actual YAML content
  if (startIndex >= 0) {
    debugLog(`Found YAML start index: ${startIndex}`);
    text = text.slice(startIndex);
  }

  return text;
}

export interface ExtractMarkdownToYamlOptions {
  issueUrls?: string[];
  planRmfilterArgs?: string[];
  output: string;
  projectId?: number;
  stubPlan?: { data: PlanSchema; path: string };
  updatePlan?: { data: PlanSchema; path: string };
  commit?: boolean;
  generatedBy?: 'agent' | 'oneshot';
  researchContent?: string;
}

export async function extractMarkdownToYaml(
  inputText: string,
  config: RmplanConfig,
  quiet: boolean,
  options: ExtractMarkdownToYamlOptions
): Promise<string> {
  let convertedYaml: string;

  try {
    // First try to see if it's YAML already.
    let maybeYaml = findYamlStart(inputText);
    const parsedObject = yaml.parse(maybeYaml, {
      strict: false,
    });
    convertedYaml = yaml.stringify(parsedObject);
  } catch {
    // Print output if not quiet
    const streamToConsole = !quiet;
    const numLines = inputText.split('\n').length;
    if (!quiet) {
      warn(boldMarkdownHeaders(`\n## Converting ${numLines} lines of Markdown to YAML\n`));
    }
    convertedYaml = await convertMarkdownToYaml(inputText, config, !streamToConsole);
  }

  // Parse the YAML to check if it's multi-phase
  let parsedYaml;
  try {
    parsedYaml = await fixYaml(convertedYaml, 5, config);
  } catch (e) {
    await Bun.write('rmplan-parse-failure.yml', convertedYaml);
    error('Failed to parse YAML. Saved raw output to rmplan-parse-failure.yml');
    throw e;
  }

  // Check if this is a multi-phase plan
  if (parsedYaml.phases && Array.isArray(parsedYaml.phases)) {
    // Multi-phase plan, combine intelligently
    return await saveMultiPhaseYaml(parsedYaml, options, config, quiet);
  }

  // Single-phase plan - continue with existing logic
  let validatedPlan: PlanSchema;

  if (!convertedYaml.startsWith('# yaml-language-server')) {
    const schemaLine = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json`;
    convertedYaml = schemaLine + '\n' + convertedYaml;
  }

  // Parse and validate the YAML
  try {
    const result = planSchema.safeParse(parsedYaml);
    if (!result.success) {
      error('Validation errors after LLM conversion:', result.error);
      // Save the failed YAML for debugging
      await Bun.write('rmplan-validation-failure.yml', convertedYaml);
      console.error('Invalid YAML (saved to rmplan-validation-failure.yml):', convertedYaml);
      throw new Error('Validation failed');
    }
    validatedPlan = result.data;

    // Preserve all fields from the original plan that aren't in the updated plan
    // This includes fields like parent, container, baseBranch, changedFiles, etc.
    const fieldsToPreserve = [
      'parent',
      'container',
      'baseBranch',
      'changedFiles',
      'pullRequest',
      'assignedTo',
      'docs',
      'issue',
      'rmfilter',
      'dependencies',
      'priority',
      'project',
    ] as const;

    // When updating a plan, preserve all existing fields that weren't explicitly updated
    if (options.updatePlan?.data) {
      const originalPlan = options.updatePlan.data;

      for (const field of fieldsToPreserve) {
        if (originalPlan[field] !== undefined && validatedPlan[field] === undefined) {
          (validatedPlan as any)[field] = originalPlan[field];
        }
      }

      // Always preserve these metadata fields from the original
      validatedPlan.id = originalPlan.id;
      validatedPlan.createdAt = originalPlan.createdAt;
      validatedPlan.updatedAt = new Date().toISOString();

      // Only update planGeneratedAt if the plan structure changed
      validatedPlan.planGeneratedAt =
        validatedPlan.planGeneratedAt || originalPlan.planGeneratedAt || new Date().toISOString();

      // Preserve promptsGeneratedAt from original
      validatedPlan.promptsGeneratedAt = originalPlan.promptsGeneratedAt;

      // Set status from original if not set
      if (!validatedPlan.status) {
        if (originalPlan.status === 'done') {
          validatedPlan.status = 'in_progress';
        } else {
          validatedPlan.status = originalPlan.status || 'pending';
        }
      }

      // Set generatedBy if provided
      if (options.generatedBy) {
        validatedPlan.generatedBy = options.generatedBy;
      }
    } else {
      // Not an update - set metadata fields for new plan
      validatedPlan.id =
        options.stubPlan?.data?.id ||
        options.projectId ||
        (await generateNumericPlanId(await resolveTasksDir(config)));
      const now = new Date().toISOString();
      validatedPlan.createdAt = options.stubPlan?.data?.createdAt || now;
      validatedPlan.updatedAt = now;
      validatedPlan.planGeneratedAt = now;

      // Set defaults for status if not already set
      if (!validatedPlan.status) {
        validatedPlan.status = 'pending';
      }

      // Set generatedBy if provided
      if (options.generatedBy) {
        validatedPlan.generatedBy = options.generatedBy;
      }
    }

    // Inherit fields from stub plan if provided
    if (options.stubPlan?.data) {
      const stubPlanDetails = options.stubPlan.data.details?.trim();
      const stubPlanTitle = options.stubPlan.data.title?.trim();
      const stubPlanGoal = options.stubPlan.data.goal?.trim();

      if (stubPlanTitle) {
        validatedPlan.title = stubPlanTitle;
      }

      if (stubPlanGoal) {
        validatedPlan.goal = stubPlanGoal;
      }

      if (stubPlanDetails) {
        validatedPlan.details = [
          '# Original Plan Details',
          stubPlanDetails,
          '# Processed Plan Details',
          validatedPlan.details,
        ].join('\n\n');
      }

      // Merge the fixed fields, combining arrays and preferring the stub plan for scalars
      for (const field of fieldsToPreserve) {
        const stubValue = options.stubPlan.data[field];
        const newValue = validatedPlan[field];

        if (
          (stubValue == null || Array.isArray(stubValue)) &&
          (newValue == null || Array.isArray(newValue))
        ) {
          (validatedPlan as any)[field] = Array.from(
            new Set([...(stubValue || []), ...(newValue || [])])
          );
        } else if (stubValue !== undefined) {
          (validatedPlan as any)[field] = stubValue;
        }
      }
    }

    // Populate issue and rmfilter arrays from options (only for new plans, not updates)
    // For updates, these are already preserved from the original plan above
    if (!options.updatePlan?.data) {
      if (options.issueUrls && options.issueUrls.length > 0) {
        validatedPlan.issue = options.issueUrls;
      }
      if (options.planRmfilterArgs && options.planRmfilterArgs.length > 0) {
        validatedPlan.rmfilter = options.planRmfilterArgs;
      }
    }

    // Special handling for plan updates: merge tasks while preserving completed ones
    if (options.updatePlan?.data) {
      const originalTasks = options.updatePlan.data.tasks;
      const updatedTasks = validatedPlan.tasks;

      // Build a map of original completed tasks (all steps done)
      const completedTasks = new Map<number, (typeof originalTasks)[0]>();
      originalTasks.forEach((task, index) => {
        if (isTaskDone(task)) {
          completedTasks.set(index, task);
        }
      });

      // Parse task IDs from the updated markdown to match tasks
      const taskIdRegex = /\[TASK-(\d+)\]/;
      const mergedTasks: typeof originalTasks = [];

      // First, add all completed tasks in their original positions
      for (const [index, task] of completedTasks) {
        mergedTasks[index] = task;
      }

      // Then process updated tasks
      updatedTasks.forEach((updatedTask) => {
        // Try to extract task ID from title
        const match = updatedTask.title.match(taskIdRegex);
        if (match) {
          const taskIndex = parseInt(match[1]) - 1; // Convert to 0-based index
          // Remove the task ID from the title
          updatedTask.title = updatedTask.title.replace(taskIdRegex, '').trim();

          // Only update if this was not a completed task
          if (!completedTasks.has(taskIndex)) {
            mergedTasks[taskIndex] = updatedTask;
          }
        } else {
          // New task without ID - add to the end
          mergedTasks.push(updatedTask);
        }
      });

      // Filter out any undefined entries and reassign
      validatedPlan.tasks = mergedTasks.filter((task) => task !== undefined);
    }
  } catch (e) {
    // Save the failed YAML for debugging
    await Bun.write('rmplan-conversion-failure.yml', convertedYaml);
    error(
      'Failed to parse YAML output from LLM conversion. Saved raw output to rmplan-conversion-failure.yml'
    );
    error('Parsing error:', e);
    throw e;
  }

  if (options.researchContent?.trim()) {
    validatedPlan = appendResearchToPlan(validatedPlan, options.researchContent);
  }

  // Write single-phase plan to output file
  const outputPath =
    options.output.endsWith('.yml') || options.output.endsWith('.plan.md')
      ? options.output
      : `${options.output}.plan.md`;
  await writePlanFile(outputPath, validatedPlan);

  if (!quiet) {
    log(chalk.green('Success!'), `Wrote single-phase plan to ${outputPath}`);
  }

  // Commit if requested
  if (options.commit) {
    const gitRoot = await getGitRoot();
    const commitMessage = `Add plan: ${validatedPlan.title || validatedPlan.goal}`;
    await commitAll(commitMessage, gitRoot);
    if (!quiet) {
      log(chalk.green('✓ Committed changes'));
    }
  }

  return `Successfully created plan file at ${outputPath}`;
}

export async function saveMultiPhaseYaml(
  parsedYaml: any,
  options: ExtractMarkdownToYamlOptions,
  config: RmplanConfig,
  quiet: boolean
): Promise<string> {
  // Always combine phases into a single plan file.
  const projectInfo = {
    goal: parsedYaml.goal || '',
    title: parsedYaml.title || '',
    details: parsedYaml.details || '',
  };

  // Combine tasks from all phases in order
  const combinedTasks: PlanSchema['tasks'] = [];
  for (const phase of parsedYaml.phases) {
    if (Array.isArray(phase.tasks)) {
      combinedTasks.push(...phase.tasks);
    }
  }

  // Format phase title + details into a single Markdown document to include in details
  const detailsSections: string[] = [];
  if (projectInfo.details?.trim()) {
    const projectHeader = projectInfo.title?.trim() ? `## ${projectInfo.title.trim()}` : undefined;
    detailsSections.push([projectHeader, projectInfo.details.trim()].filter(Boolean).join('\n\n'));
  }

  parsedYaml.phases.forEach((phase: any, idx: number) => {
    const title = (phase.title || '').toString().trim();
    const details = (phase.details || '').toString().trim();
    // We call them "areas" an an additional hint to the agent that it's ok to do tasks across areas
    // when it makes sense.
    const header = title ? `## Area ${idx + 1}: ${title}` : `## Area ${idx + 1}`;
    const taskTitles = phase.tasks
      .map((t: any) => t.title)
      .map((t: any) => `- ${t}`)
      .join('\n');
    if (details) {
      detailsSections.push(`${header}\n\nTasks:\n${taskTitles}\n\n${details}`);
    } else {
      // Always include a header so phases are visible even without details
      detailsSections.push(`${header}\n\nTasks:\n${taskTitles}`);
    }
  });

  const combinedDetailsDoc = detailsSections.join('\n\n---\n\n');

  // Build the combined plan
  const initialPlan: PlanSchema = {
    title: options.stubPlan?.data.title?.trim() || projectInfo.title || undefined,
    goal: options.stubPlan?.data.goal?.trim() || projectInfo.goal || '',
    details: combinedDetailsDoc,
    status: options.updatePlan?.data?.status || options.stubPlan?.data?.status || 'pending',
    priority: options.stubPlan?.data?.priority || undefined,
    tasks: combinedTasks,
  } as PlanSchema;

  // Validate and normalize
  const validation = planSchema.safeParse(initialPlan);
  if (!validation.success) {
    throw new Error(
      'Combined multi-phase YAML failed validation: ' +
        validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
    );
  }
  let combinedPlan = validation.data;

  if (options.researchContent?.trim()) {
    combinedPlan = appendResearchToPlan(combinedPlan, options.researchContent, {
      insertedAt: false,
    });
  }

  // Preserve or set metadata similar to the single-phase path
  const fieldsToPreserve = [
    'parent',
    'container',
    'baseBranch',
    'pullRequest',
    'assignedTo',
    'priority',
    'project',
  ] as const;

  const arrayFieldsToPreserve = [
    'changedFiles',
    'docs',
    'issue',
    'dependencies',
    'rmfilter',
  ] as const;

  if (options.updatePlan?.data) {
    const original = options.updatePlan.data;
    for (const field of [...fieldsToPreserve, ...arrayFieldsToPreserve]) {
      if (original[field] !== undefined && combinedPlan[field] === undefined) {
        (combinedPlan as any)[field] = original[field];
      }
    }
    combinedPlan.id = original.id;
    combinedPlan.createdAt = original.createdAt;
    combinedPlan.updatedAt = new Date().toISOString();
    combinedPlan.planGeneratedAt =
      combinedPlan.planGeneratedAt || original.planGeneratedAt || new Date().toISOString();

    // Preserve promptsGeneratedAt from original
    combinedPlan.promptsGeneratedAt = original.promptsGeneratedAt;

    if (!combinedPlan.status) {
      combinedPlan.status = original.status || 'pending';
    }
  } else {
    const tasksDir = await resolveTasksDir(config);
    combinedPlan.id =
      options.stubPlan?.data?.id || options.projectId || (await generateNumericPlanId(tasksDir));
    const now = new Date().toISOString();
    combinedPlan.createdAt = options.stubPlan?.data?.createdAt || now;
    combinedPlan.updatedAt = now;
    combinedPlan.planGeneratedAt = now;
    if (!combinedPlan.status) {
      combinedPlan.status = 'pending';
    }
  }

  // Inherit fields from stub plan if provided (merge arrays, prefer stub for scalars)
  if (options.stubPlan?.data) {
    const stubPlanDetails = options.stubPlan.data.details?.trim();
    const stubPlanTitle = options.stubPlan.data.title?.trim();
    const stubPlanGoal = options.stubPlan.data.goal?.trim();

    if (stubPlanTitle) {
      combinedPlan.title = stubPlanTitle;
    }
    if (stubPlanGoal) {
      combinedPlan.goal = stubPlanGoal;
    }
    if (stubPlanDetails) {
      combinedPlan.details = [
        '# Original Plan Details',
        stubPlanDetails,
        '# Processed Plan Details',
        combinedPlan.details,
      ].join('\n\n');
    }

    for (const field of fieldsToPreserve) {
      const stubValue = options.stubPlan.data[field];
      if (stubValue !== undefined) {
        (combinedPlan as any)[field] = stubValue;
      }
    }
    for (const field of arrayFieldsToPreserve) {
      const stubValue = options.stubPlan.data[field];
      const newValue = combinedPlan[field];
      if (
        (stubValue == null || Array.isArray(stubValue)) &&
        (newValue == null || Array.isArray(newValue))
      ) {
        (combinedPlan as any)[field] = Array.from(
          new Set([...(stubValue || []), ...(newValue || [])])
        );
      } else if (stubValue !== undefined) {
        (combinedPlan as any)[field] = stubValue;
      }
    }
  }

  // Populate issue/rmfilter for new plans (not updates)
  if (!options.updatePlan?.data) {
    if (options.issueUrls && options.issueUrls.length > 0) {
      combinedPlan.issue = options.issueUrls;
    }
    if (options.planRmfilterArgs && options.planRmfilterArgs.length > 0) {
      combinedPlan.rmfilter = options.planRmfilterArgs;
    }
  }

  // Determine output file path
  const outputPath =
    options.output.endsWith('.yml') || options.output.endsWith('.plan.md')
      ? options.output
      : `${options.output}.plan.md`;

  if (options.generatedBy) {
    combinedPlan.generatedBy = options.generatedBy;
  }
  await writePlanFile(outputPath, combinedPlan);

  if (!quiet) {
    log(chalk.green('Success!'), `Wrote combined plan to ${outputPath}`);
  }

  if (options.commit) {
    const gitRoot = await getGitRoot();
    const projectTitle =
      combinedPlan.title || combinedPlan.goal || parsedYaml.title || parsedYaml.goal;
    const commitMessage = `Add plan: ${projectTitle}`;
    await commitAll(commitMessage, gitRoot);
    if (!quiet) {
      log(chalk.green('✓ Committed changes'));
    }
  }

  return `Successfully created plan file at ${outputPath}`;
}
