export const planExampleFormat = `
title: A concise single-sentence title for the project plan
goal: the goal of the project plan
details: details and analysis about the plan
tasks:
  - title: the title of a task
    description: more information about the task
    files:
      - src/index.ts
      - other files
    steps:
      - prompt: |
          This is a multiline prompt
          describing what to do.
      - prompt: Another step`;

export const planExampleFormatGeneric = `title: [single-line string - a concise title for the plan]
goal: [single-line string]
details: [single-line or multi-line string]
tasks:
  - title: [single-line string]
    description: [single-line or multi-line string]
    files:
      - [list of relevant file paths]
    steps:
      - prompt: [multi-line string using the | character]`;

export const phaseExampleFormatGeneric = `phases:
  - id: [phase-id]
    title: [phase title - a concise single-sentence title]
    goal: [phase goal]
    details: [phase details]
    dependencies: [list of phase IDs this phase depends on, or empty list]
    tasks:
      - title: [task title]
        description: [task description]
        files: []
        steps: []
    status: pending
    priority: unknown`;

// Define the desired Markdown structure for the plan
export const planMarkdownExampleFormat = `
# Title
[A concise single-sentence title for the project]

## Goal
[Project goal here]

### Details
[Detailed description and analysis]

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

## Details
[Overall project details and analysis]

## Phase 1: [Phase Title]

### Goal
[Phase-specific goal]

### Dependencies
[None or comma-separated list, e.g., Phase 2, Phase 3]

### Details
[Phase description]

### Tasks

#### Task 1: [Task 1 Title]

[Task 1 description]

#### Task 2: [Task 2 Title]

[Task 2 description]

## Phase 2: [Phase Title]

### Goal
[Phase-specific goal]

### Dependencies
[None or comma-separated list, e.g., Phase 1]

### Details
[Phase description]

### Tasks

#### Task 1: [Task 1 Title]

[Task 1 description]

#### Task 2: [Task 2 Title]

[Task 2 description]
`;

export interface PhaseGenerationContext {
  overallProjectGoal: string;
  overallProjectDetails: string;
  currentPhaseGoal: string;
  currentPhaseDetails: string;
  currentPhaseTasks: Array<{ title: string; description: string }>; // Tasks from the current phase YAML (before step generation)
  previousPhasesInfo: Array<{ id: string; title: string; goal: string; description: string }>; // Info from dependent, completed phases
  changedFilesFromDependencies: string[]; // Concatenated list of changedFiles from completed dependencies
  rmfilterArgsFromPlan: string[]; // rmfilter args from the original plan/request
  // Potentially add baseBranch if needed
}

export function planPrompt(plan: string) {
  // The first half of this prompt is a variant of the planning prompt from https://harper.blog/2025/02/16/my-llm-codegen-workflow-atm/
  return `This is a project plan for an upcoming feature.

# Project Plan

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
- An overall goal and project details
- Multiple phases (or a single phase for smaller features), each with:
  - A phase title: A concise single-sentence title for the phase
  - A phase-specific goal
  - Dependencies on other phases (if any)
  - Phase details
  - A list of tasks with titles and descriptions

IMPORTANT: In this high-level plan, tasks must include BOTH a title and a description.

The title must be a single-sentence title that captures the essence of the task.
The description may be anywhere in length from one sentence to a paragraph, depending on the complexity of the task.

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
  return `This is a project plan for an upcoming feature.

# Project Plan
${plan}

# Plan Creation

Please think about how to accomplish the task and create a detailed, step-by-step blueprint for it. The blueprint should
work in the context of the provided codebase. Examine the provided codebase and identify which files need to be edited for each step.

Break it down into small, iterative chunks that build on each other. Look at these chunks and then go another round to break it into small steps. Review the results and make sure that the steps are small enough to be implemented safely with strong testing, but big enough to move the project forward. Iterate until you feel that the steps are right sized for this project.

From here you should have the foundation to provide a series of prompts for a code-generation LLM that will implement each step in a test-driven manner. Prioritize best practices, incremental progress, and early testing, ensuring no big jumps in complexity at any stage. Make sure that each prompt builds on the previous prompts, and ends with everything wired together. There should be no hanging or orphaned code that isn't integrated into a previous step. At the end of the task, update the relevant documentation in README.md or other files too.

This plan will be executed by an AI coding agent, so "manual verify" instructions do not need to be part of the plan.

When testing, prefer to use real tests and not mock functions or modules. Prefer dependency injection instead of mocks. Tests that need IO can create files in a temporary directory.

The goal is to output prompts, but context, etc is important as well. Include plenty of information about which files to edit, what to do and how to do it, but you do not need to output code samples.

When generating the final output with the prompts, output a title (a concise single-sentence title for the project), an overall goal, project details, and then a list of tasks.

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
      `## ${phase.title} (ID: ${phase.id})
**Goal:** ${phase.goal}
**Description:** ${phase.description}`
  )
  .join('\n\n')}

# Files Changed in Previous Phases
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

  return `# Phase Implementation Generation

You are generating detailed implementation steps for a specific phase of a larger project.

## Overall Project Context

**Project Goal:** ${context.overallProjectGoal}

**Project Details:** ${context.overallProjectDetails}

${previousPhasesSection}

## Current Phase Details

**Phase Goal:** ${context.currentPhaseGoal}

**Phase Details:** ${context.currentPhaseDetails}

## Tasks to Implement

${tasksSection}

## Instructions

For each task listed above, you need to generate:
1. **files**: The specific files that need to be created or modified for this task
4. **steps**: Implementation steps -- each step should be a prompt a few sentences long

### Guidelines:

1. **Test-Driven Development**:
   - Include test creation/modification as early steps when appropriate
   - Prefer to not mocks unless you have to, since they often end up just testing the mocks. Prefer dependency injection.
2. **Incremental Progress**: Each step should be small, achievable, and verifiable
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
   - No need to generate code, the agent reading the prompt will generate it from the prompt.

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
- Consider the rmfilter arguments that will be used: ${context.rmfilterArgsFromPlan.join(' ')}
`;
}
