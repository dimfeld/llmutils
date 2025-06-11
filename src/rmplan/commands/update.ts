// Command handler for 'rmplan update'
// Updates an existing plan with new information from a linked GitHub issue or other sources

import * as os from 'os';
import * as path from 'path';
import { log, error } from '../../logging.js';
import { getGitRoot } from '../../common/git.js';
import { logSpawn } from '../../common/process.js';
import { waitForEnter } from '../../common/terminal.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanFile, readPlanFile } from '../plans.js';
import { convertYamlToMarkdown, extractMarkdownToYaml } from '../process_markdown.js';
import { runRmfilterProgrammatically } from '../../rmfilter/rmfilter.js';
import * as clipboard from '../../common/clipboard.js';

export async function handleUpdateCommand(planFile: string, options: any, command: any) {
  const globalOpts = command.parent.opts();
  const gitRoot = (await getGitRoot()) || process.cwd();

  const config = await loadEffectiveConfig(globalOpts.config);
  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);

  log(`Update command called with plan file: ${resolvedPlanFile}`);

  // Get the update description either from command line or editor
  let updateDescription: string;

  if (options.description && !options.editor) {
    // Use the description provided via command line
    updateDescription = options.description;
  } else {
    // Open editor to get the update description
    const tmpDescPath = path.join(os.tmpdir(), `rmplan-update-desc-${Date.now()}.md`);

    try {
      // Create empty temp file
      await Bun.write(tmpDescPath, '');

      // Open editor with the temporary file
      const editor = process.env.EDITOR || 'nano';
      const editorProcess = logSpawn([editor, tmpDescPath], {
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      await editorProcess.exited;

      // Read the description from the temporary file
      try {
        updateDescription = await Bun.file(tmpDescPath).text();
      } catch (err) {
        throw new Error('Failed to read update description from editor.');
      }

      if (!updateDescription || !updateDescription.trim()) {
        throw new Error('No update description was provided from the editor.');
      }
    } catch (err) {
      throw new Error(`Failed to get update description from editor: ${err as Error}`);
    } finally {
      // Clean up the temporary file
      try {
        await Bun.file(tmpDescPath).unlink();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }

  log(
    `Update description: ${updateDescription.substring(0, 100)}${updateDescription.length > 100 ? '...' : ''}`
  );

  // Load the existing plan
  const planData = await readPlanFile(resolvedPlanFile);
  log(`Loaded plan: ${planData.title || `Plan ${planData.id}`}`);

  // Convert the plan to markdown format with task IDs
  const planMarkdown = convertYamlToMarkdown(planData, { includeTaskIds: true });

  // Generate the update prompt
  const updatePrompt = generateUpdatePrompt(planMarkdown, updateDescription);

  // Find '--' in process.argv to get extra args for rmfilter
  const doubleDashIdx = process.argv.indexOf('--');
  const userCliRmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];

  if (
    (userCliRmfilterArgs.length > 0 && userCliRmfilterArgs[0] === options.description) ||
    !options.description
  ) {
    // Commander can't differentiate between a description before the double dash and the first
    // rmfilter argument where there is no description, so if we get here it means
    // there was no description.
    throw new Error('Usage: rmplan update <plan> "description" -- <rmfilter args>');
  }

  // Combine user CLI args and plan's rmfilter args
  const allRmfilterOptions: string[] = [];
  for (const argList of [userCliRmfilterArgs, planData.rmfilter]) {
    if (!argList?.length) continue;
    // Add a separator if some options already exist
    if (allRmfilterOptions.length) allRmfilterOptions.push('--');
    allRmfilterOptions.push(...argList);
  }

  // Construct rmfilter arguments
  const rmfilterArgs: string[] = ['--bare', '--instructions', updatePrompt];

  // Add docs if available
  if (planData.docs) {
    planData.docs.forEach((doc) => {
      rmfilterArgs.push('--docs', doc);
    });
  }

  // Add all rmfilter options
  rmfilterArgs.push(...allRmfilterOptions);

  // Run rmfilter programmatically
  const rmfilterResult = await runRmfilterProgrammatically(rmfilterArgs, gitRoot);

  // Copy the result to clipboard
  await clipboard.write(rmfilterResult);

  log('Update prompt with context has been copied to clipboard.');
  log('Next steps:');
  log('1. Paste the prompt into your LLM chat interface');
  log('2. Copy the updated plan from the LLM response');
  log("3. Press Enter when you've copied the response");

  // Wait for user to paste the LLM's response
  const llmResponse = await waitForEnter(true);

  if (!llmResponse || !llmResponse.trim()) {
    throw new Error('No response from LLM was provided');
  }

  // Extract the YAML from the markdown response and update the plan
  await extractMarkdownToYaml(llmResponse, config, globalOpts.quiet || false, {
    output: resolvedPlanFile,
    updatePlan: { data: planData, path: resolvedPlanFile },
    issueUrls: planData.issue,
    planRmfilterArgs: planData.rmfilter,
    commit: options.commit,
  });

  log(`Successfully updated plan: ${resolvedPlanFile}`);
}

export function generateUpdatePrompt(planAsMarkdown: string, updateDescription: string): string {
  return `# Plan Update Task

You are acting as a project manager tasked with updating an existing project plan based on requested changes.

## Current Plan

You have been provided with an existing plan in Markdown format:

${planAsMarkdown}

## Requested Update

The following changes have been requested:

${updateDescription}

## Instructions

Please analyze the existing plan and the requested changes, then:

1. **Return the ENTIRE updated plan** in the exact same Markdown format as provided
2. **CRITICAL: Preserve ALL completed tasks exactly as they appear**
   - Completed tasks are marked with ✓ and appear in the "Completed Tasks" section
   - Do NOT modify, remove, or change any completed tasks
   - If a completed task contains steps you would want to modify, instead add a new task that builds on the completed task to make the appropriate changes.
   - Keep all task IDs (e.g., [TASK-1], [TASK-2]) exactly as shown
3. For **Pending Tasks** only, you may:
   - Add new tasks
   - Remove existing pending tasks
   - Modify pending tasks (title, description, files, steps)
   - Reorder pending tasks
4. When adding new tasks:
   - Continue the task numbering sequence (e.g., if the last task is [TASK-5], new tasks should be [TASK-6], [TASK-7], etc.)
   - Place new tasks in the appropriate section based on their completion status
5. **Preserve the structure**:
   - Keep the "Completed Tasks" section if it exists
   - Keep the "Pending Tasks" section for tasks that are not yet done
   - Maintain the separation between completed and pending tasks
6. **Preserve any unmodified parts** of the plan exactly as they were
7. Ensure the updated plan maintains consistency and logical flow

## Required Output Format

Your response must follow the exact structure of the input plan, maintaining:
- The same header levels and formatting
- Task ID format [TASK-N]
- Completed task markers (✓)
- Section separators (---)
- Code block formatting for prompts

## Important Notes

- Output ONLY the updated plan in Markdown format
- Do not include any explanations, commentary, or text outside the plan structure
- Maintain the exact formatting with proper headers, bullet points, and code blocks
- If the existing plan uses phase-based structure, maintain that structure in your update
- Ensure all changes align with the requested update while keeping the plan coherent
- NEVER modify completed tasks - they represent work that has already been done`;
}
