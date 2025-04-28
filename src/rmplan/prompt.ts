export const planExampleFormat = `
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

export const planExampleFormatGeneric = `goal: [single-line string]
details: [single-line or multi-line string]
tasks:
  - title: [single-line string]
    description: [single-line or multi-line string]
    files:
      - [list of relevant file paths]
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

export function planPrompt(plan: string) {
  // This is a variant of the planning prompt from https://harper.blog/2025/02/16/my-llm-codegen-workflow-atm/
  return `This is a project plan for an upcoming feature.

# Project Plan

${plan}

# Plan Creation

Please think about how to accomplish the task and create a detailed, step-by-step blueprint for it. The blueprint should
work in the context of the provided codebase. Examine the provided codebase and identify which files need to be edited for each step.

Break it down into small, iterative chunks that build on each other. Look at these chunks and then go another round to break it into small steps. Review the results and make sure that the steps are small enough to be implemented safely with strong testing, but big enough to move the project forward. Iterate until you feel that the steps are right sized for this project.

From here you should have the foundation to provide a series of prompts for a code-generation LLM that will implement each step in a test-driven manner. Prioritize best practices, incremental progress, and early testing, ensuring no big jumps in complexity at any stage. Make sure that each prompt builds on the previous prompts, and ends with everything wired together. There should be no hanging or orphaned code that isn't integrated into a previous step.

The goal is to output prompts, but context, etc is important as well. Remember when creating a prompt that the model executing it may not have all the context you have and will not be as smart as you, so you need to be very detailed and include plenty of information about which files to edit, what to do and how to do it.

When generating the final output with the prompts, output an overall goal, project details, and then a list of tasks. Each task should have a list of relevant files and a list of steps, where each step is a prompt. The relevant files should include the files to edit, and also any other files that contain relevant code that will be used from the edited files, but do not include dependencies or built-in system libraries in this list.

Use the following Markdown format for your final prompt output:
\`\`\`
${planMarkdownExampleFormat}
\`\`\`


If there are any changes requested or comments made after your create this plan, think about how to make the changes to the project plan, update the project plan appropriately, and output the entire updated plan again in the proper format.
`;
}
