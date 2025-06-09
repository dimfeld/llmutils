import clipboard from 'clipboardy';
import * as path from 'node:path';
import * as os from 'node:os';
import { getGitRoot } from '../../common/git.js';
import { logSpawn } from '../../common/process.js';
import { sshAwarePasteAction } from '../../common/ssh_detection.js';
import { waitForEnter } from '../../common/terminal.js';
import { log } from '../../logging.js';
import { readPlanFile, resolvePlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';

/**
 * Handles the rmplan research command.
 * Generates research prompts for plan investigations and copies them to the clipboard.
 *
 * @param planArg - Plan file path or ID
 * @param options - Command options including --rmfilter flag
 * @param command - Commander command instance
 */
export async function handleResearchCommand(
  planArg: string,
  options: { rmfilter?: boolean },
  command: any
): Promise<void> {
  // Get global options from parent command
  const globalOptions = command.parent.opts();

  // Resolve the plan file path
  const planFile = await resolvePlanFile(planArg, globalOptions.config);

  // Extract additional arguments passed after a `--` separator
  const argv = process.argv;
  const separatorIndex = argv.indexOf('--');
  const rmfilterArgs = separatorIndex !== -1 ? argv.slice(separatorIndex + 1) : [];

  // Call the core action function
  await handleResearch(planFile, {
    rmfilter: options.rmfilter,
    rmfilterArgs,
  });
}

async function handleResearch(
  planFile: string,
  options: { rmfilter?: boolean; rmfilterArgs?: string[] }
): Promise<void> {
  // Read the plan file
  let planData = await readPlanFile(planFile);

  // Generate research prompt
  const prompt = generateResearchPrompt(planData);

  let tempPromptFile: string | null = null;

  try {
    // Check if rmfilter option is enabled
    if (options.rmfilter) {
      // Combine rmfilter arguments from plan's rmfilter field with command-line file arguments
      const planRmfilterArgs = planData.rmfilter || [];
      const commandLineArgs = options.rmfilterArgs || [];
      const combinedArgs = [...planRmfilterArgs, ...commandLineArgs];

      // If there are any combined rmfilter arguments, use rmfilter to generate context-aware prompt
      if (combinedArgs.length > 0) {
        // Generate the research prompt and write it to a temporary file
        tempPromptFile = path.join(
          os.tmpdir(),
          `rmplan-research-prompt-${Date.now()}-${crypto.randomUUID()}.md`
        );
        await Bun.write(tempPromptFile, prompt);

        // Get the git root directory
        const gitRoot = await getGitRoot();

        // Use logSpawn to execute rmfilter with the combined file/filter arguments, --copy, and --instructions
        await logSpawn(
          ['rmfilter', '--copy', '--instructions', `@${tempPromptFile}`, ...combinedArgs],
          { cwd: gitRoot }
        ).exited;

        log('Research prompt with context copied to clipboard via rmfilter');
      } else {
        // Fall back to original behavior if no rmfilter arguments provided
        await clipboard.write(prompt);
        log('Research prompt copied to clipboard');
      }
    } else {
      // Fall back to original behavior when --rmfilter is false
      await clipboard.write(prompt);
      log('Research prompt copied to clipboard');
    }

    log(`Perform your research, then ${sshAwarePasteAction()} the results back into the terminal.`);

    // Wait for user to paste their research
    const pastedContent = await waitForEnter(true);

    // If pasted content is not empty, append it to the details field
    if (pastedContent && pastedContent.trim()) {
      planData.details = planData.details + '\n\n--- Research ---\n\n' + pastedContent.trim();

      // Update the updatedAt timestamp
      planData.updatedAt = new Date().toISOString();

      // Save the modified plan back to the file
      await writePlanFile(planFile, planData);

      log('Plan updated with research results');
    } else {
      log('No research content was pasted');
    }
  } finally {
    // Ensure the temporary prompt file is deleted after the rmfilter process completes
    if (tempPromptFile) {
      try {
        await Bun.file(tempPromptFile).unlink();
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  }
}

function generateResearchPrompt({ goal, details }: PlanSchema): string {
  return `# Research Assistant

You are acting as a research assistant to help gather relevant information for a project.

## Research Topic

**Goal**: ${goal}

**Details**: ${details}

## Your Task

Please conduct research on the topic described above and provide a comprehensive response that includes:

1. **Summary**: A concise overview of the key concepts and current state of the topic
2. **Key Findings**: The most important insights, facts, or discoveries related to this topic
3. **Relevant Information**: Additional context, background, or supporting details that would be useful
4. **Sources and Links**: Any relevant documentation, articles, repositories, or other resources (include URLs when possible)
5. **Recommendations**: Based on your research, any suggestions or best practices that could be helpful

## Output Format

Please structure your response clearly with headings and organize the information in a way that would be most useful for planning and implementation. Focus on providing actionable insights and practical information that can guide decision-making.

Be thorough but concise, and prioritize information that is most directly relevant to the stated goal and details.
`;
}
