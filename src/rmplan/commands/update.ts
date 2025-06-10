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
import { generateUpdatePrompt } from '../prompt.js';

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

  // Convert the plan to markdown format
  const planMarkdown = convertYamlToMarkdown(planData);

  // Generate the update prompt
  const updatePrompt = generateUpdatePrompt(planMarkdown, updateDescription);

  // Create a temporary file for the prompt
  const tmpPromptPath = path.join(os.tmpdir(), `rmplan-update-prompt-${Date.now()}.md`);
  let wrotePrompt = false;

  try {
    await Bun.write(tmpPromptPath, updatePrompt);
    wrotePrompt = true;
    log('Update prompt written to:', tmpPromptPath);

    // Find '--' in process.argv to get extra args for rmfilter
    const doubleDashIdx = process.argv.indexOf('--');
    const userCliRmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];

    // Combine user CLI args and plan's rmfilter args
    const allRmfilterOptions: string[] = [];
    for (const argList of [userCliRmfilterArgs, planData.rmfilter]) {
      if (!argList?.length) continue;
      // Add a separator if some options already exist
      if (allRmfilterOptions.length) allRmfilterOptions.push('--');
      allRmfilterOptions.push(...argList);
    }

    // Collect docs from plan
    const docsArgs: string[] = [];
    if (planData.docs) {
      planData.docs.forEach((doc) => {
        docsArgs.push('--docs', doc);
      });
    }

    // Construct rmfilter arguments
    const rmfilterArgs = [
      'rmfilter',
      ...allRmfilterOptions,
      ...docsArgs,
      '--bare',
      '--copy',
      '--instructions',
      `@${tmpPromptPath}`,
    ];

    // Execute rmfilter
    const proc = logSpawn(rmfilterArgs, {
      cwd: gitRoot,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    const exitRes = await proc.exited;

    if (exitRes !== 0) {
      throw new Error(`rmfilter exited with code ${exitRes}`);
    }

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
  } finally {
    if (wrotePrompt) {
      try {
        await Bun.file(tmpPromptPath).unlink();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}
