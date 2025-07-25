import * as path from 'path';
import type { PlanSchema } from './planSchema.js';
import type { RmplanConfig } from './configSchema.js';
import { buildPlanContextPrompt, isURL } from './context_helpers.js';
import { getGitRoot } from '../common/git.js';
import type { Executor } from './executors/types.js';

/**
 * Options for building execution prompts
 */
export interface ExecutionPromptOptions {
  executor: Executor;
  planData: PlanSchema;
  planFilePath: string;
  baseDir: string;
  config: RmplanConfig;
  task?: {
    title: string;
    description?: string;
    files?: string[];
  };
  filePathPrefix?: string;
  includeCurrentPlanContext?: boolean;
}

/**
 * Build the project or phase context section of a prompt
 */
export function buildProjectContextSection(planData: PlanSchema): string {
  const parts: string[] = [];

  if (planData.project?.goal) {
    // We have a project-level context
    parts.push(
      `# Project Goal: ${planData.project.goal}\n`,
      'These instructions define a particular task of a feature implementation for this project'
    );

    if (planData.project.details) {
      parts.push(`## Project Details:\n\n${planData.project.details}\n`);
    }

    parts.push(
      `# Current Phase Goal: ${planData.goal}\n\n## Phase Details:\n\n${planData.details}\n`
    );
  } else {
    // No project-level context, use phase as top-level
    parts.push(`# Project Goal: ${planData.goal}\n\n## Project Details:\n\n${planData.details}\n`);
  }

  return parts.join('\n');
}

/**
 * Build a task section for the prompt
 */
export function buildTaskSection(task: { title: string; description?: string }): string {
  const parts: string[] = [];

  parts.push(
    `## Task: ${task.title}\n`,
    `Description: ${task.description || 'No description provided'}`
  );

  return parts.join('\n');
}

/**
 * Build a documentation URLs section
 */
export function buildDocumentationSection(
  docs: string[] | undefined,
  isURL: (str: string) => boolean
): string {
  if (!docs || docs.length === 0) {
    return '';
  }

  const docURLs = docs.filter(isURL);
  if (docURLs.length === 0) {
    return '';
  }

  let section = `## Documentation URLs\n\n`;
  docURLs.forEach((url) => {
    section += `- ${url}\n`;
  });
  section += `\n`;

  return section;
}

/**
 * Build a file list section (for rmfilter paths or task files)
 */
export async function buildFileListSection(
  files: string[] | undefined,
  baseDir: string,
  filePathPrefix?: string,
  sectionTitle: string = 'Relevant Files',
  sectionDescription?: string
): Promise<string> {
  if (!files || files.length === 0) {
    return '';
  }

  const parts: string[] = [`\n## ${sectionTitle}`];

  if (sectionDescription) {
    parts.push(`\n${sectionDescription}`);
  }

  const gitRoot = await getGitRoot(baseDir);
  const prefix = filePathPrefix || '';

  // Strip parenthetical comments from filenames and make paths relative
  const cleanFiles = files
    .filter((file) => !file.startsWith('-')) // Filter out flags (for rmfilter)
    .map((file) => {
      const cleanFile = file.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const relativePath = path.isAbsolute(cleanFile)
        ? path.relative(gitRoot, cleanFile)
        : cleanFile;
      return `- ${prefix}${relativePath}`;
    });

  if (cleanFiles.length === 0) {
    return '';
  }

  parts.push(...cleanFiles);
  return parts.join('\n');
}

/**
 * Build a unified execution prompt for stub plans and simple tasks
 */
export async function buildExecutionPromptWithoutSteps(
  options: ExecutionPromptOptions
): Promise<string> {
  const {
    executor,
    planData,
    planFilePath,
    baseDir,
    config,
    task,
    filePathPrefix,
    includeCurrentPlanContext = true,
  } = options;

  const promptParts: string[] = [];

  // Add project/phase context
  const projectContext = buildProjectContextSection(planData);
  if (projectContext) {
    promptParts.push(projectContext);
  }

  // Add parent plan context and sibling plans information
  const planContext = await buildPlanContextPrompt({
    planData,
    planFilePath,
    baseDir,
    config,
    includeCurrentPlanContext,
  });
  if (planContext) {
    promptParts.push(planContext);
  }

  // Add task details if provided
  if (task) {
    const taskSection = buildTaskSection(task);
    if (taskSection) {
      promptParts.push(taskSection);
    }

    // Add task files if available
    if (task.files && task.files.length > 0) {
      const fileSection = await buildFileListSection(
        task.files,
        baseDir,
        filePathPrefix,
        'Relevant Files',
        'These are relevant files for this task. If you think additional files are relevant, you can update them as well.'
      );
      if (fileSection) {
        promptParts.push(fileSection);
      }
    }
  } else {
    // For stub plans, add rmfilter paths if available
    if (planData.rmfilter?.length) {
      const fileSection = await buildFileListSection(
        planData.rmfilter,
        baseDir,
        filePathPrefix,
        'Potential file paths to look at'
      );
      if (fileSection) {
        promptParts.push(fileSection);
      }
    }
  }

  // Add documentation URLs
  const docSection = buildDocumentationSection(planData.docs, isURL);
  if (docSection) {
    promptParts.push(docSection);
  }

  // Add execution guidelines
  const executionGuidelines = buildExecutionGuidelines(executor);
  promptParts.push(executionGuidelines);

  return promptParts.join('\n');
}

/**
 * Build execution guidelines section
 */
function buildExecutionGuidelines(executor: Executor): string {
  let todoDirections = executor.todoDirections;
  if (todoDirections) {
    todoDirections = `### Track Your Progress
Create a TODO list to organize your work:
- Break down the task into specific, actionable items
- Include items for code changes, tests, and verification
- Track which items are completed as you progress
- Update the list if you discover additional work needed
${todoDirections}
`;
  }

  return `
## Execution Guidelines

### Understand the Codebase Context
Before implementing changes:
- Examine existing patterns and conventions in the codebase
- Look for similar implementations or components that can serve as examples
- Understand the project structure and where your changes fit
- Review any relevant tests to understand expected behavior

${todoDirections}

### Follow Best Practices
Ensure your implementation:
- Matches the existing code style and patterns
- Uses the same libraries and utilities already in the codebase
- Follows the project's naming conventions
- Maintains consistent error handling patterns
- Includes appropriate type annotations

### Verify Your Work
After implementing changes:
- Run the build command to ensure compilation succeeds
- Execute tests to verify functionality
- Run linting tools to check code quality
- Fix any issues before considering the task complete

### Self-Review Checklist
Before marking the task as done, verify:
- [ ] Changes align with the plan's goals and requirements
- [ ] Code follows existing patterns in the codebase
- [ ] All tests pass successfully
- [ ] Linting checks pass without errors
- [ ] No unnecessary files or debug code included
- [ ] Changes are focused and don't include unrelated modifications

Remember: Quality is more important than speed. Take time to understand the codebase and verify your changes work correctly within the existing system.`;
}
