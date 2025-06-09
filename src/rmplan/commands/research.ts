import * as clipboard from '../../common/clipboard.js';
import { getGitRoot } from '../../common/git.js';
import { sshAwarePasteAction } from '../../common/ssh_detection.js';
import { waitForEnter } from '../../common/terminal.js';
import { log } from '../../logging.js';
import { readPlanFile, resolvePlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { runRmfilterProgrammatically } from '../../rmfilter/rmfilter.js';

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
  researchGoal: string | undefined,
  options: { rmfilter?: boolean; tutorial?: boolean },
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
  await handleResearch({
    planFile,
    researchGoal,
    rmfilter: options.rmfilter,
    tutorial: options.tutorial,
    rmfilterArgs,
  });
}

async function handleResearch(options: {
  planFile: string;
  researchGoal?: string;
  rmfilter?: boolean;
  tutorial?: boolean;
  rmfilterArgs?: string[];
}): Promise<void> {
  // Read the plan file
  let planData = await readPlanFile(options.planFile);

  // Generate research prompt
  const prompt = generateResearchPrompt(planData, options.researchGoal, options.tutorial);

  let rmfilterOptions: string[] = [];
  // Check if rmfilter option is enabled
  if (options.rmfilter && planData.rmfilter) {
    rmfilterOptions.push(...planData.rmfilter);
  }

  const commandLineArgs = options.rmfilterArgs || [];
  if (commandLineArgs.length > 0) {
    rmfilterOptions.push('--', ...commandLineArgs);
  }

  // If there are any combined rmfilter arguments, use rmfilter to generate context-aware prompt
  if (rmfilterOptions.length > 0) {
    // Get the git root directory
    const gitRoot = await getGitRoot();

    const result = await runRmfilterProgrammatically(
      ['--instructions', prompt, '--bare', ...rmfilterOptions],
      gitRoot
    );

    await clipboard.write(result);

    log('Research prompt with context copied to clipboard');
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
    const researchDate = new Date().toDateString();
    const researchHeader = options.researchGoal
      ? `# Research ${researchDate}: ${options.researchGoal}`
      : `# Research ${researchDate}`;
    planData.details =
      (planData.details?.trimEnd() || '') + `\n\n${researchHeader}\n\n` + pastedContent.trim();

    // Update the updatedAt timestamp
    planData.updatedAt = new Date().toISOString();

    // Save the modified plan back to the file
    await writePlanFile(options.planFile, planData);

    log('Plan updated with research results');
  } else {
    log('No research content was pasted');
  }
}

function generateResearchPrompt(
  { goal, details }: PlanSchema,
  researchGoal?: string,
  tutorial?: boolean
): string {
  const primaryGoal = researchGoal || goal;
  const contextSection = researchGoal
    ? `

## Project Context

**Overall Project Goal**: ${goal}

**Specific Research Focus**: ${researchGoal}`
    : '';

  if (tutorial) {
    return `# Tutorial Creation Assistant

You are acting as a senior engineer creating a tutorial for a junior engineer.

## Tutorial Topic

**Goal**: ${primaryGoal}${contextSection}

**Details**: ${details}

## Your Task

Please create a comprehensive tutorial suitable for a junior engineer to understand and implement this task. Your tutorial should include:

1. **Overview**: A clear explanation of what we're building and why
2. **Prerequisites**: What the junior engineer should know or have set up before starting
3. **Key Concepts**: Explain any important concepts, patterns, or technologies they'll need to understand
4. **Step-by-Step Implementation**:
   - Break down the implementation into clear, manageable steps
   - Include code examples for each step
   - Explain why each step is necessary and what it accomplishes
5. **Common Pitfalls**: Warn about typical mistakes and how to avoid them
6. **Testing**: How to verify that the implementation works correctly
7. **Further Learning**: Resources for deepening their understanding

## Tutorial Guidelines

- Use clear, simple language
- Explain technical terms when you first use them
- Include practical examples and analogies where helpful
- Assume basic programming knowledge but not domain expertise
- Focus on teaching both the "how" and the "why"


Structure your tutorial to build understanding progressively, starting with fundamentals and moving to more complex aspects.
`;
  }

  return `# Research Assistant

You are acting as a research assistant to help gather relevant information for a project.

## Research Topic

**Goal**: ${primaryGoal}${contextSection}

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
