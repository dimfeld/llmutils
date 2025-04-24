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

When generating the final output with the prompts, output an overall goal, project details, and then a list of tasks. Each task should have a list of files to edit and a list of steps, where each step is part of the prompt. The tool that consumes this YAML will join the data for a task together into a single prompt.

<formatting>
Use the following YAML format for your final prompt output:
\`\`\`yaml
${planExampleFormat}
\`\`\`
</formatting>
`;
}
