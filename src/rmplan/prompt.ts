import type { PlanSchema } from './planSchema.js';
import yaml from 'yaml';
import path from 'path';

export const planExampleFormatGeneric = `title: [single-line string - a concise title for the plan]
goal: [single-line string]
details: [single-line or multi-line string]
priority: [low|medium|high|urgent - based on importance and time sensitivity]
tasks:
  - title: [single-line string]
    description: [single-line or multi-line string]
    files:
      - [list of relevant file paths]
    steps:
      - prompt: [multi-line string using the | character]`;

export const phaseExampleFormatGeneric = `title: [single-line string - a concise title for the project]
goal: [single-line string]
details: [single-line or multi-line string]
priority: [low|medium|high|urgent - based on importance and time sensitivity]
phases:
  - title: [phase title - a concise single-sentence title]
    goal: [phase goal]
    details: [phase details, a multi-line string including constraints on the implementation and acceptance criteria]
    priority: [low|medium|high|urgent - based on importance and time sensitivity]
    dependencies: [list of phase IDs this phase depends on, or empty list]
    tasks:
      - title: [task title]
        description: [task description]
    status: pending`;

// Define the desired Markdown structure for the plan
export const planMarkdownExampleFormat = `
# Title
[A concise single-sentence title for the project]

## Goal
[Project goal here]

## Priority
[low|medium|high|urgent]

### Details
[Detailed description and analysis, including constraints on the implementation and acceptance criteria for the project]

---

## Task: [Task 1 Title]
**Description:** [Task 1 Description]
**Files:**
- path/to/relevant/file1.ext
- path/to/another/file.ext

**Steps:**
1.  **Prompt:**
    \`\`\`
    [Multiline prompt for step 1]
    \`\`\`
2.  **Prompt:**
    \`\`\`
    [Prompt for step 2]
    \`\`\`
---
## Task: [Task 2 Title]
... etc ...
`;

// Define the phase-based Markdown structure for the plan
export const phaseBasedMarkdownExampleFormat = `
# Title
[A concise single-sentence title for the overall project]

## Goal
[Overall project goal]

## Priority
[low|medium|high|urgent]

## Details
[Overall project details and analysis, including constraints on the implementation and acceptance criteria for the project]

## Phase 1: [Phase Title]

### Goal
[Phase-specific goal]

### Priority
[low|medium|high|urgent]

### Dependencies
[None or comma-separated list, e.g., Phase 2, Phase 3]

### Details
[Phase description including what will be accomplished, constraints on the implementation, and acceptance criteria for this phase]

### Tasks

#### Task 1: [Task 1 Title]

[Task 1 description]

#### Task 2: [Task 2 Title]

[Task 2 description]

## Phase 2: [Phase Title]

### Goal
[Phase-specific goal]

### Priority
[low|medium|high|urgent]

### Dependencies
[None or comma-separated list, e.g., Phase 1]

### Details
[Phase description including what will be accomplished and acceptance criteria for this phase]

### Tasks

#### Task 1: [Task 1 Title]

[Task 1 description]

#### Task 2: [Task 2 Title]

[Task 2 description]
`;

export interface PhaseGenerationContext {
  overallProjectGoal: string;
  overallProjectDetails: string;
  overallProjectTitle?: string; // Optional project title
  currentPhaseTitle?: string;
  currentPhaseGoal?: string;
  currentPhaseDetails: string;
  currentPhaseTasks: Array<{ title: string; description: string }>; // Tasks from the current phase YAML (before step generation)
  previousPhasesInfo: Array<{
    id: string | number;
    title: string;
    goal?: string;
    description: string;
  }>; // Info from dependent, completed phases
  parentPlanInfo?: {
    id: number;
    title: string;
    goal?: string;
    details: string;
    docURLs?: string[]; // URLs from parent plan docs
  }; // Info from parent plan
  siblingPlansInfo?: {
    completed: Array<{ id: number; title: string; filename: string }>;
    pending: Array<{ id: number; title: string; filename: string }>;
  }; // Info about sibling plans (same parent)
  changedFilesFromDependencies: string[]; // Concatenated list of changedFiles from completed dependencies
  rmfilterArgsFromPlan: string[]; // rmfilter args from the original plan/request
  currentPhaseDocURLs?: string[]; // URLs from current phase docs
  currentPlanFilename?: string; // Current plan's filename
  // Potentially add baseBranch if needed
}

const commonGenerateDetails = `
Expected Behavior/Outcome
- A clear, concise description of the new user-facing behavior.
- Definition of all relevant states

Key Findings
- **Product & User Story**
- **Design & UX Approach**
- **Technical Plan & Risks**
- **Pragmatic Effort Estimate**

Acceptance Criteria
- [ ] Functional Criterion: e.g. User can click X and see Y.
- [ ] UX Criterion: e.g. The page is responsive and includes a loading state.
- [ ] Technical Criterion: e.g. The API endpoint returns a \`201\` on success.
- [ ] All new code paths are covered by tests.

Dependencies & Constraints
- **Dependencies**: Relies on existing Pagination component.
- **Technical Constraints**: Must handle >10K records efficiently.

Implementation Notes
- **Recommended Approach**
- **Potential Gotchas**
- **Conflicting, Unclear, or Impossible Requirements, if any** -- you can omit this section if there are none
`;

export function planPrompt(plan: string) {
  // The first half of this prompt is a variant of the planning prompt from https://harper.blog/2025/02/16/my-llm-codegen-workflow-atm/
  return `This is a description for an upcoming feature, and you will be tasked with creating a plan for it.

# Project Description

${plan}

# Plan Creation

Please think about how to accomplish the task and create a detailed, step-by-step blueprint for it. The blueprint should
work in the context of the provided codebase. Examine the provided codebase and identify which files need to be edited for each step.

Break this project into phases where each phase delivers working functionality. Each phase should build upon previous phases. Later phases can enhance or extend features from earlier phases.

For smaller features, a single phase is acceptable. For larger features, consider natural boundaries like:
- Backend implementation → Frontend implementation → Polish/reporting
- Core functionality → Enhanced features → Performance optimization
- Basic CRUD → Advanced queries → UI improvements

Break it down into small, iterative chunks that build on each other. Look at these chunks and then go another round to break it into small steps. Review the results and make sure that the steps are small enough to be implemented safely with strong testing, but big enough to move the project forward. Iterate until you feel that the steps are right sized for this project.

Focus on organizing the work into logical phases. Prioritize best practices, incremental progress, and early testing, ensuring no big jumps in complexity at any stage. Make sure that each phase builds on the previous phases, and ends with fully integrated functionality. At the end of the project, include documentation updates in README.md or other files as appropriate.

This plan will be executed by an AI coding agent, so "manual verify" instructions can be added as notes but should not be part of the plan.

When testing, prefer to use real tests and not mock functions or modules. Prefer dependency injection instead of mocks. Tests that need IO can create files in a temporary directory.

The goal is to output a high-level phase-based plan. Focus on the overall structure and organization of the project, breaking it into phases and tasks.

When generating the final output, create a phase-based plan with:
- A title: A concise single-sentence title that captures the essence of the project
- An overall goal and project details. The details section should include:
  - A comprehensive analysis of the work to be done
  - Acceptance criteria for the overall project (what conditions must be met for the project to be considered complete)
  - Technical considerations and approach
  - Any important constraints or assumptions
- A priority: Assign a priority level (low, medium, high, or urgent) based on:
  - low: Nice-to-have features or improvements with no pressing timeline
  - medium: Important features that should be done but aren't blocking critical functionality
  - high: Critical features or fixes that are needed soon or blocking other work
  - urgent: Must be done immediately, fixing production issues or critical blockers
- Multiple phases (or a single phase for smaller features), each with:
  - A phase title: A concise single-sentence title for the phase
  - A phase-specific goal
  - A phase priority: May differ from overall priority based on phase urgency
  - Dependencies on other phases (if any)
  - Phase details that include:
    - What will be accomplished in this phase
    - Acceptance criteria specific to this phase
    - How this phase contributes to the overall project goal
  - A list of tasks with titles and descriptions

The details section should include these sections:

${commonGenerateDetails}

IMPORTANT: In this high-level plan, tasks must include BOTH a title and a description.

The title must be a single-sentence title that captures the essence of the task.
The description may be anywhere in length from one sentence to a paragraph, depending on the complexity of the task. Tasks should be self-contained pieces of functionality. If you have been provided a list of tasks you may split the provided tasks to make them better self-contained.

Tasks should only include a title and description. Do NOT include in tasks:
- Detailed implementation steps or prompts
- File names to edit

These implementation details will be generated later when each phase is expanded.

Use the following Markdown format for your final output:
\`\`\`
${phaseBasedMarkdownExampleFormat}
\`\`\`


If there are any changes requested or comments made after your create this plan, think about how to make the changes to the project plan, update the project plan appropriately, and output the entire updated plan again in the proper format.
`;
}

export function simplePlanPrompt(plan: string) {
  return `This is a description for an upcoming feature, and you will be tasked with creating a plan for it.

# Project Description

${plan}

# Plan Creation

Please think about how to accomplish the task and create a detailed, step-by-step blueprint for it. The blueprint should
work in the context of the provided codebase. Examine the provided codebase and identify which files need to be edited for each step.

Break it down into small, iterative chunks that build on each other. Look at these chunks and then go another round to break it into small steps. Review the results and make sure that the steps are small enough to be implemented safely with strong testing, but big enough to move the project forward. Iterate until you feel that the steps are right sized for this project.

From here you should have the foundation to provide a series of prompts for a code-generation LLM that will implement each step in a test-driven manner. Prioritize best practices, incremental progress, and early testing, ensuring no big jumps in complexity at any stage. Make sure that each prompt builds on the previous prompts, and ends with everything wired together. There should be no hanging or orphaned code that isn't integrated into a previous step. At the end of the task, update the relevant documentation in README.md or other files too.

This plan will be executed by an AI coding agent, so "manual verify" instructions do not need to be part of the plan.

When testing, prefer to use real tests and not mock functions or modules. Prefer dependency injection instead of mocks. Tests that need IO can create files in a temporary directory.

The goal is to output prompts, but context, etc is important as well. Include plenty of information about which files to edit, what to do and how to do it, but you do not need to output code samples.

When generating the final output with the prompts, output a title (a concise single-sentence title for the project), an overall goal, project details (including acceptance criteria for the overall project), a priority level, and then a list of tasks.

For the priority level, choose one of the following based on importance and urgency:
- low: Nice-to-have features or improvements with no pressing timeline
- medium: Important features that should be done but aren't blocking critical functionality
- high: Critical features or fixes that are needed soon or blocking other work
- urgent: Must be done immediately, fixing production issues or critical blockers

Each task should have a list of relevant files and a list of steps, where each step is a prompt a few sentences long. The relevant files should include the files to edit, and also any other files that contain relevant code that will be used from the edited files, but do not include library dependencies or built-in system libraries in this list.

Every step in a task should be at most a few sentences long and relate to the information in the task's description. If a step needs to be more than a few sentences, consider that it should be separate task.

Use the following Markdown format for your final prompt output:

\`\`\`
${planMarkdownExampleFormat}
\`\`\`

If there are any changes requested or comments made after your create this plan, think about how to make the changes to the project plan, update the project plan appropriately, and output the entire updated plan again in the proper format.`;
}

export function generatePhaseStepsPrompt(context: PhaseGenerationContext): string {
  // Format previous phases info
  const previousPhasesSection =
    context.previousPhasesInfo.length > 0
      ? `# Previous Completed Phases

${context.previousPhasesInfo
  .map(
    (phase) =>
      `## ${phase.title} (ID: ${phase.id})${phase.goal ? `\n**Goal:** ${phase.goal}` : ''}
**Description:** ${phase.description}`
  )
  .join('\n\n')}

# Files Changed in Previous Plans
${context.changedFilesFromDependencies.join('\n')}
`
      : '';

  // Format current phase tasks
  const tasksSection = context.currentPhaseTasks
    .map(
      (task, index) =>
        `### Task ${index + 1}: ${task.title}
**Description:** ${task.description}`
    )
    .join('\n\n');

  // Build the overall project context section only if we have meaningful content
  const hasProjectContext =
    context.overallProjectGoal || context.overallProjectDetails || context.overallProjectTitle;

  let projectContextSection = '';
  if (hasProjectContext) {
    const contextParts: string[] = ['## Overall Project Context\n'];

    if (context.overallProjectTitle) {
      contextParts.push(`**Project Title:** ${context.overallProjectTitle}\n`);
    }
    if (context.overallProjectGoal) {
      contextParts.push(`**Project Goal:** ${context.overallProjectGoal}\n`);
    }
    if (context.overallProjectDetails) {
      contextParts.push(`**Project Details:** ${context.overallProjectDetails}\n`);
    }

    projectContextSection = contextParts.join('\n') + '\n';
  }

  // Build parent plan section
  let parentPlanSection = '';
  if (context.parentPlanInfo) {
    parentPlanSection = `## Parent Plan Context

**Parent Plan:** ${context.parentPlanInfo.title} (ID: ${context.parentPlanInfo.id})${context.parentPlanInfo.goal ? `\n**Parent Goal:** ${context.parentPlanInfo.goal}` : ''}
**Parent Details:** ${context.parentPlanInfo.details}
`;

    if (context.parentPlanInfo.docURLs && context.parentPlanInfo.docURLs.length > 0) {
      parentPlanSection += `**Parent Documentation URLs:**\n`;
      context.parentPlanInfo.docURLs.forEach((url) => {
        parentPlanSection += `- ${url}\n`;
      });
    }

    parentPlanSection += '\n';
  }

  // Build sibling plans section
  let siblingPlansSection = '';
  if (
    context.siblingPlansInfo &&
    (context.siblingPlansInfo.completed.length > 0 || context.siblingPlansInfo.pending.length > 0)
  ) {
    siblingPlansSection = `## Related Plans (Same Parent)\n\n`;
    siblingPlansSection += `These plans are part of the same parent plan. Reference them for additional context about the overall project structure.\n\n`;

    if (context.siblingPlansInfo.completed.length > 0) {
      siblingPlansSection += `### Completed Related Plans:\n`;
      context.siblingPlansInfo.completed.forEach((sibling) => {
        siblingPlansSection += `- **${sibling.title}** (File: ${path.basename(sibling.filename)})\n`;
      });
      siblingPlansSection += '\n';
    }

    if (context.siblingPlansInfo.pending.length > 0) {
      siblingPlansSection += `### Pending Related Plans:\n`;
      context.siblingPlansInfo.pending.forEach((sibling) => {
        siblingPlansSection += `- **${sibling.title}** (File: ${path.basename(sibling.filename)})\n`;
      });
      siblingPlansSection += '\n';
    }
  }

  // Build documentation URLs section for current phase
  let docURLsSection = '';
  if (context.currentPhaseDocURLs && context.currentPhaseDocURLs.length > 0) {
    docURLsSection = `## Documentation URLs\n\n`;
    context.currentPhaseDocURLs.forEach((url) => {
      docURLsSection += `- ${url}\n`;
    });
    docURLsSection += '\n';
  }

  // Add current plan filename if available
  let currentPlanSection = '';
  if (context.currentPlanFilename) {
    currentPlanSection = `## Current Plan File: ${context.currentPlanFilename}\n\n`;
  }

  return `# Plan Implementation Generation

You are generating detailed implementation steps${hasProjectContext ? ' for a specific phase of a larger project' : ' for a project'}.

${currentPlanSection}${projectContextSection}${parentPlanSection}${siblingPlansSection}${previousPhasesSection}

## Current Plan Details

**Project Goal:** ${context.currentPhaseGoal || context.currentPhaseTitle}

**Project Details:** ${context.currentPhaseDetails}

${docURLsSection}## Tasks to Implement

${tasksSection}

## Instructions

For each task listed above, you need to generate:
1. **files**: The specific files that need to be created or modified for this task
2. **steps**: Implementation steps -- each step should be a prompt a few sentences long

### Guidelines:

1. **Test-Driven Development**:
   - Include test creation/modification as early steps when appropriate
   - Prefer to not mocks unless you have to, since they often end up just testing the mocks. Prefer dependency injection.
2. **Incremental Progress**: Each step should be self-contained, achievable, and verifiable
3. **Build on Previous Work**: Reference and utilize code/patterns from completed phases listed above
4. **Description**:
   - Most of the details on the task should go into the description.
   - Work from the existing task description, but you can add details if needed.
   - Reference relevant patterns from the codebase and other information which provides context for the steps.
5. **File Selection**:
   - Be specific about which files need modification
   - Consider files changed in previous phases when they're relevant
6. **Step Prompts**:
   - Write clear, actionable prompts for each step
   - Each step should be at most a few sentences long and related to the information in the task's description.
   - The agent implementing the code is smart and has access to the entire codebase, so you should be clear on what to do, but not overly prescriptive.
   - No need to supply sample code in your prompts unless it illustrates a specific code pattern.
   - If a task is designed to create documentation, make sure to save the documentation in a file so that the later tasks can reference it.

### Output Format

Generate a YAML snippet containing ONLY the tasks array with fully populated implementation details:

\`\`\`yaml
tasks:
  - title: [Task 1 Title]
    description: [Task 1 Description]
    files:
      - path/to/file1.ts
      - path/to/file2.ts
    steps:
      - prompt: |
          [Detailed, multi-line prompt for step 1]
          [Include specific requirements and context]
      - prompt: |
          [Detailed prompt for step 2]
  - title: [Task 2 Title]
    description: [Task 2 Description]
    files:
      - path/to/file3.ts
    steps:
      - prompt: |
          [Detailed prompt for this task]
\`\`\`

IMPORTANT:
- Output ONLY the YAML tasks array, no other text
- Ensure all fields are properly populated
- Use proper YAML syntax with correct indentation
- Multi-line prompts should use the pipe (|) character
`;
}

export function generateSplitPlanPrompt(plan: PlanSchema): string {
  // Construct the prompt explaining the goal
  const prompt = `# Plan Reorganization Task

You are tasked with taking a single, detailed project plan and reorganizing its tasks into a multi-phase structure.

## Input Plan

You have been provided with:
- **Title**: ${plan.title || 'Not specified'}
${plan.goal ? `- **Goal**: ${plan.goal}` : ''}
- **Details**: ${plan.details}
- **Tasks**: A list of ${plan.tasks.length} tasks, each containing:
  - Title
  - Description
  - Files (list of file paths)
  - Steps (list of implementation steps with prompts)

## Your Task

Please perform the following actions:

1. **Define the overarching project structure**:
   - Create or derive a project-level title, goal, and details
   - These can be based on the input plan's top-level fields or adjusted as needed

2. **Logically group tasks into distinct phases**:
   - Analyze the provided tasks and identify natural phase boundaries
   - Group related tasks that work together to deliver specific functionality
   - Consider dependencies and logical progression between tasks

3. **For each phase, generate**:
   - A phase-specific title (concise single sentence)
   - A phase-specific goal
   - Phase details explaining what will be accomplished
   - A priority level (low, medium, high, or urgent) based on phase importance
   - Assignment of the relevant original tasks to this phase

4. **Identify and list dependencies**:
   - Determine which phases depend on other phases
   - Express dependencies in a clear format (e.g., dependencies: ["Phase 2"])
   - Dependencies should reflect the logical order of implementation

5. **Task modification**:
   - Tasks may be split into multiple other tasks to reduce complexity as part of this process.
   - The requirements of the original task must be met by the new tasks.

## Output Format

Output a YAML structure following this format:

\`\`\`yaml
title: [Overarching project title]
goal: [Overarching project goal]
details: [Overarching project details]
priority: [low|medium|high|urgent]
phases:
  - title: [Phase 1 title - concise single sentence]
    goal: [Phase 1 specific goal]
    details: [Phase 1 details]
    priority: [low|medium|high|urgent]
    dependencies: []  # Empty for first phase
    tasks:
      - title: [Original task title]
        description: [Original task description]
        files:
          - [Original file paths]
        steps:
          - prompt: |
              [Original step prompt]
  - title: [Phase 2 title]
    goal: [Phase 2 goal]
    details: [Phase 2 details]
    priority: [low|medium|high|urgent]
    dependencies: ["Phase 1"]  # Human-readable dependency reference
    tasks:
      - title: [Original task title]
        description: [Original task description]
        files:
          - [Original file paths]
        steps:
          - prompt: |
              [Original step prompt]
\`\`\`

## Important Notes

- The overall structure should have a top-level object with title, goal, details, priority, and a phases array
- Each phase within the phases array should be structured like a plan with its own title, goal, details, priority, and tasks
- All original task details (description, files, steps) MUST be preserved exactly as provided
- Dependencies should be expressed in human-readable format that can later be mapped to phase IDs
- Output ONLY the raw YAML string without any surrounding text, explanations, or markdown code fences
- Do not include \`\`\`yaml or \`\`\` markers in your output

## Original Tasks to Reorganize

${yaml.stringify(plan.tasks, null, 2)}
`;

  return prompt;
}

export function generateClaudeCodePlanningPrompt(planText: string): string {
  return `This is a description for an upcoming feature that I want you to analyze and prepare a plan for.

# Project Description

${planText}

# Instructions

Please analyze this project description and the codebase. Your task is to:

1. Use your tools to explore the codebase and understand the existing code structure
2. Identify which files would need to be created or modified to implement this feature
3. Think about how to break this down into logical phases and tasks
4. Consider dependencies between different parts of the implementation
5. Identify any potential challenges or considerations

Once you've analyzed the codebase, I'll ask you to generate a detailed implementation plan in a specific format.

For now, please:
- Explore the relevant parts of the codebase
- Understand the existing patterns and conventions
- Identify the key files and components that will be involved
- Think about the best approach to implement this feature


Make sure your plan includes these details:

${commonGenerateDetails}

Do not perform any implementation or write any files yet.

Use parallel subagents to analyze the requirements against different parts of the codebase, and generate detailed reports.
Then prepare to synthesize these reports into the final plan.
When you're done with your analysis, let me know and I'll provide the next instruction.`;
}

export function generateClaudeCodeGenerationPrompt(): string {
  return `Based on your analysis of the codebase and the project description, please now generate a detailed implementation plan.

The plan should be formatted as follows:
- Break the project into phases (or a single phase for smaller features)
- Each phase should have a clear goal, details, and tasks
- Focus on logical progression and incremental functionality
- Include acceptance criteria for each phase

Please output the plan in the exact Markdown format specified below:

${phaseBasedMarkdownExampleFormat}

Everything you said above will not be saved anywhere, so be sure to include it again when generating the plan below. Remember to include all the below sections in the project details, along with any other relevant details that an engineer will require to know how to implement the plan:
${commonGenerateDetails}

Generate the complete plan now.`;
}

export function generateClaudeCodePhaseStepsPlanningPrompt(
  context: PhaseGenerationContext
): string {
  // Build the same context sections as generatePhaseStepsPrompt
  const previousPhasesSection =
    context.previousPhasesInfo.length > 0
      ? `# Previous Completed Phases

${context.previousPhasesInfo
  .map(
    (phase) =>
      `## ${phase.title} (ID: ${phase.id})${phase.goal ? `\n**Goal:** ${phase.goal}` : ''}
**Description:** ${phase.description}`
  )
  .join('\n\n')}

# Files Changed in Previous Phases
${context.changedFilesFromDependencies.join('\n')}
`
      : '';

  const tasksSection = context.currentPhaseTasks
    .map(
      (task, index) =>
        `### Task ${index + 1}: ${task.title}
**Description:** ${task.description}`
    )
    .join('\n\n');

  const hasProjectContext =
    context.overallProjectGoal || context.overallProjectDetails || context.overallProjectTitle;

  let projectContextSection = '';
  if (hasProjectContext) {
    const contextParts: string[] = ['## Overall Project Context\n'];

    if (context.overallProjectTitle) {
      contextParts.push(`**Project Title:** ${context.overallProjectTitle}\n`);
    }
    if (context.overallProjectGoal) {
      contextParts.push(`**Project Goal:** ${context.overallProjectGoal}\n`);
    }
    if (context.overallProjectDetails) {
      contextParts.push(`**Project Details:** ${context.overallProjectDetails}\n`);
    }

    projectContextSection = contextParts.join('\n') + '\n';
  }

  let parentPlanSection = '';
  if (context.parentPlanInfo) {
    parentPlanSection = `## Parent Plan Context

**Parent Plan:** ${context.parentPlanInfo.title} (ID: ${context.parentPlanInfo.id})${context.parentPlanInfo.goal ? `\n**Parent Goal:** ${context.parentPlanInfo.goal}` : ''}
**Parent Details:** ${context.parentPlanInfo.details}
`;

    if (context.parentPlanInfo.docURLs && context.parentPlanInfo.docURLs.length > 0) {
      parentPlanSection += `**Parent Documentation URLs:**\n`;
      context.parentPlanInfo.docURLs.forEach((url) => {
        parentPlanSection += `- ${url}\n`;
      });
    }

    parentPlanSection += '\n';
  }

  let siblingPlansSection = '';
  if (
    context.siblingPlansInfo &&
    (context.siblingPlansInfo.completed.length > 0 || context.siblingPlansInfo.pending.length > 0)
  ) {
    siblingPlansSection = `## Related Plans (Same Parent)\n\n`;
    siblingPlansSection += `These plans are part of the same parent plan. Reference them for additional context about the overall project structure.\n\n`;

    if (context.siblingPlansInfo.completed.length > 0) {
      siblingPlansSection += `### Completed Related Plans:\n`;
      context.siblingPlansInfo.completed.forEach((sibling) => {
        siblingPlansSection += `- **${sibling.title}** (File: ${path.basename(sibling.filename)})\n`;
      });
      siblingPlansSection += '\n';
    }

    if (context.siblingPlansInfo.pending.length > 0) {
      siblingPlansSection += `### Pending Related Plans:\n`;
      context.siblingPlansInfo.pending.forEach((sibling) => {
        siblingPlansSection += `- **${sibling.title}** (File: ${path.basename(sibling.filename)})\n`;
      });
      siblingPlansSection += '\n';
    }
  }

  let docURLsSection = '';
  if (context.currentPhaseDocURLs && context.currentPhaseDocURLs.length > 0) {
    docURLsSection = `## Documentation URLs\n\n`;
    context.currentPhaseDocURLs.forEach((url) => {
      docURLsSection += `- ${url}\n`;
    });
    docURLsSection += '\n';
  }

  let currentPlanSection = '';
  if (context.currentPlanFilename) {
    currentPlanSection = `## Current Plan File: ${context.currentPlanFilename}\n\n`;
  }

  // Build potential files and directories section from rmfilterArgsFromPlan
  let potentialFilesSection = '';
  if (context.rmfilterArgsFromPlan && context.rmfilterArgsFromPlan.length > 0) {
    const filesAndDirs = context.rmfilterArgsFromPlan
      .filter((arg) => !arg.startsWith('-')) // Exclude flags
      .filter((arg) => arg.length > 0); // Exclude empty strings

    if (filesAndDirs.length > 0) {
      potentialFilesSection = `## Potential Files and Directories\n\n`;
      potentialFilesSection += `The following files and directories were identified as potentially relevant:\n\n`;
      filesAndDirs.forEach((item) => {
        potentialFilesSection += `- ${item}\n`;
      });
      potentialFilesSection += '\n';
    }
  }

  return `# Project Implementation Analysis

You are analyzing a project consisting of multiple tasks to prepare for generating detailed implementation steps.

${currentPlanSection}${projectContextSection}${parentPlanSection}${siblingPlansSection}${previousPhasesSection}

## Plan Details

**Project Goal:** ${context.currentPhaseGoal || context.currentPhaseTitle}

**Project Details:** ${context.currentPhaseDetails}

${docURLsSection}${potentialFilesSection}## Tasks to Implement

${tasksSection}

## Instructions

Please analyze this plan and the codebase. Your task is to:

1. Use your tools to explore the codebase and understand the existing code structure.
2. Identify which files would need to be created or modified for each task
3. Think about how to break down each task into detailed implementation steps
4. Consider the order of operations and any dependencies between steps
5. Understand the existing patterns, frameworks, and conventions used in the codebase
6. Identify any potential challenges or edge cases

Use parallel subagents to analyze related tasks together.
You can also use subagents to examine particular aspects of the plan such as system design or UX requirements.
All subagents should run from the perspective of an experienced, senior employee.

Once you've analyzed the codebase, I'll ask you to generate detailed implementation steps in the required YAML format.

For now, please:
- Explore the relevant parts of the codebase mentioned in the context
- If relevant, look at files changed in previous sibling or parent plans to understand patterns
- Check the project structure and existing implementations
- Identify the key files and components that will be involved
- Think about the best approach to implement each task

Do not perform any implementation or write any files yet.

When you're done with your analysis, let me know and I'll provide the next instruction.`;
}

export function generateClaudeCodePhaseStepsGenerationPrompt(): string {
  return `Based on your analysis of the codebase and the plan context, please now generate detailed implementation steps for each task.

For each task listed in the plan, you need to generate:
1. **files**: The specific files that need to be created or modified for this task
2. **steps**: Implementation steps -- each step should be a prompt a few sentences long

### Guidelines:

1. **Test-Driven Development**:
   - Include test creation/modification as early steps when appropriate
   - Prefer to not use mocks unless you have to, since they often end up just testing the mocks. Prefer dependency injection.

2. **Incremental Progress**: Each step should be self-contained, achievable, and verifiable

3. **Build on Previous Work**: Reference and utilize code/patterns from completed plans listed above, if any.

4. **Description**:
   - Most of the details on the task should go into the description.
   - Work from the existing task description, but you can add details if needed.
   - Reference relevant patterns from the codebase and other information which provides context for the steps.

5. **File Selection**:
   - Be specific about which files need modification
   - Consider files changed in previous plans when they're relevant

6. **Step Prompts**:
   - Write clear, actionable prompts for each step
   - Each step should be at most a few sentences long and related to the information in the task's description.
   - The agent implementing the code is smart and has access to the entire codebase, so you should be clear on what to do, but not overly prescriptive.
   - No need to supply sample code in your prompts unless it illustrates a specific code pattern.
   - If a task is designed to create documentation, make sure to save the documentation in a file so that the later tasks can reference it.

Everything you said above will not be saved anywhere, so be sure to include relevant details again when generating the output below.

### Output Format

Generate a YAML snippet containing ONLY the tasks array with fully populated implementation details:

\`\`\`yaml
tasks:
  - title: [Task 1 Title]
    description: [Task 1 Description]
    files:
      - path/to/file1.ts
      - path/to/file2.ts
    steps:
      - prompt: |
          [Detailed, multi-line prompt for step 1]
          [Include specific requirements and context]
      - prompt: |
          [Detailed prompt for step 2]
  - title: [Task 2 Title]
    description: [Task 2 Description]
    files:
      - path/to/file3.ts
    steps:
      - prompt: |
          [Detailed prompt for this task]
\`\`\`

IMPORTANT:
- Output ONLY the YAML tasks array, no other text
- Ensure all fields are properly populated
- Use proper YAML syntax with correct indentation
- Multi-line prompts should use the pipe (|) character`;
}
