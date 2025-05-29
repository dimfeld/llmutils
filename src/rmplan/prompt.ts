export const planExampleFormat = `
goal: the goal of the project plan
details: details and analysis about the plan
tasks:
  - title: the title of a task
    description: more information about the task
    files:
      - src/index.ts
      - other files
    include_imports: true
    include_importers: false
    steps:
      - prompt: |
          This is a multiline prompt
          describing what to do.
      - prompt: Another step`;

export const planExampleFormatGeneric = `goal: [single-line string]
details: [single-line or multi-line string]
tasks:
  - title: [single-line string]
    description: [single-line or multi-line string]
    files:
      - [list of relevant file paths]
    include_imports: [boolean]
    include_importers: [boolean]
    steps:
      - prompt: [multi-line string using the | character]`;

// Define the desired Markdown structure for the plan
export const planMarkdownExampleFormat = `
# Goal
[Project goal here]

## Details
[Detailed description and analysis]

---

## Task: [Task 1 Title]
**Description:** [Task 1 Description]
**Files:**
- path/to/relevant/file1.ext
- path/to/another/file.ext

Include Imports: Yes

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
# Goal
[Overall project goal]

## Details
[Overall project details and analysis]

---

### Phase 1: [Phase Title]
#### Goal
[Phase-specific goal]
#### Dependencies
[None or comma-separated list, e.g., Phase 2, Phase 3]
#### Details
[Phase description]
##### Task: [Task 1 Title]
**Description:** [Task 1 description]
##### Task: [Task 2 Title]
**Description:** [Task 2 description]

---

### Phase 2: [Phase Title]
#### Goal
[Phase-specific goal]
#### Dependencies
[None or comma-separated list, e.g., Phase 1]
#### Details
[Phase description]
##### Task: [Task 1 Title]
**Description:** [Task 1 description]
##### Task: [Task 2 Title]
**Description:** [Task 2 description]
`;

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
- An overall goal and project details
- Multiple phases (or a single phase for smaller features), each with:
  - A phase-specific goal
  - Dependencies on other phases (if any)
  - Phase details
  - A list of tasks with titles and descriptions only

IMPORTANT: In this high-level plan, tasks should ONLY include:
- A title
- A description

Do NOT include in tasks:
- Detailed implementation steps or prompts
- File lists
- include_imports or include_importers flags

These implementation details will be generated later when each phase is expanded.

Use the following Markdown format for your final output:
\`\`\`
${phaseBasedMarkdownExampleFormat}
\`\`\`


If there are any changes requested or comments made after your create this plan, think about how to make the changes to the project plan, update the project plan appropriately, and output the entire updated plan again in the proper format.
`;
}
