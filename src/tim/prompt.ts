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

type BlockingSubissueInstructionOptions = {
  withBlockingSubissues?: boolean;
  parentPlanId?: number;
};

function getBlockingSubissueInstructions(options: BlockingSubissueInstructionOptions): string {
  if (!options.withBlockingSubissues) {
    return '';
  }

  const planIdLabel =
    options.parentPlanId !== undefined ? String(options.parentPlanId) : '<parent-plan-id>';
  const commandExample = `tim add "Blocking Title" --parent ${planIdLabel} --discovered-from ${planIdLabel} --priority <high|medium|low|urgent> --details "Why this is needed first"`;

  return `
# Blocking Subissues

Before producing the main implementation plan, determine whether any prerequisite work must be completed first. For every prerequisite that truly blocks the main plan:
1. Create a new plan immediately with \
   \`${commandExample}\` (see the using-tim skill). Include \`--depends-on\` if a blocking plan should wait on another blocker. The parent plan's dependencies will be updated automatically.
2. Capture clear details in the blocking plan so future agents know why it is required and how to execute it.
3. Document the blockers you created in the plan's Details section under a "## Blocking Subissues" heading using this exact format:
   ## Blocking Subissue: [Title]
   - Priority: [high|medium|low|urgent]
   - Reason: [Why this must be done first]
   - Tasks: [High-level task list]

Only create blocking plans for work that must land before the main implementation can begin.
`;
}

type DiscoveredIssueInstructionOptions = {
  parentPlanId?: number;
};

function getDiscoveredIssueInstructions(options: DiscoveredIssueInstructionOptions): string {
  const planIdLabel =
    options.parentPlanId !== undefined ? String(options.parentPlanId) : '<current-plan-id>';
  const commandExample = `tim add "Discovered Issue Title" --discovered-from ${planIdLabel} --priority <high|medium|low|urgent> --details "Why this issue exists and what needs to be done"`;
  const parentHint =
    options.parentPlanId !== undefined
      ? `If the issue should live under the same parent/epic, add \`--parent ${planIdLabel}\`.`
      : 'If the issue should live under a parent/epic, add `--parent <parent-plan-id>`.';

  return `
# Discovered Issues

If you uncover new, actionable work that is OUTSIDE the current plan scope, create a new plan immediately so it can be tracked:
1. Use \`${commandExample}\` (see the using-tim skill).
2. ${parentHint}
3. If the new issue blocks the current work, treat it as a blocking subissue and add \`--depends-on\` accordingly.
4. Summarize any newly created plans in the plan's Details section under a "## Discovered Issues" heading using this format:
   ## Discovered Issue: [Title]
   - Priority: [high|medium|low|urgent]
   - Reason: [Why it was discovered / why it matters]
   - Suggested Next Steps: [Short actionable list]

Only create discovered-issue plans for concrete work that should be tracked separately.
`;
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

export function generateClaudeCodePlanningPrompt(
  planText: string,
  options: {
    includeNextInstructionSentence?: boolean;
    withBlockingSubissues?: boolean;
    parentPlanId?: number;
  } = {}
): string {
  const {
    includeNextInstructionSentence = true,
    withBlockingSubissues = false,
    parentPlanId,
  } = options;

  const blockingSection = getBlockingSubissueInstructions({
    withBlockingSubissues,
    parentPlanId,
  });
  const discoveredIssueSection = getDiscoveredIssueInstructions({
    parentPlanId,
  });

  let prompt = `This is a description for an upcoming feature that I want you to analyze and prepare a plan for.

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
- Think deeply about the best approach to implement this feature

If you are unsure whether something is already implemented in the codebase, look it up using your tools instead of asking the user.

Make sure your plan includes these details:

${commonGenerateDetails}

IMPORTANT: Do NOT create tasks for manual verification. Focus on automated testing and implementation tasks only.

Do not perform any implementation or write any files yet.

${blockingSection}
${discoveredIssueSection}

Use parallel subagents to analyze the requirements against different parts of the codebase, and generate detailed reports.
Then prepare to synthesize these reports into the final plan.`;

  if (includeNextInstructionSentence) {
    prompt += `\nWhen you're done with your analysis, let me know and I'll provide the next instruction.`;
  }
  return prompt;
}

export function generateClaudeCodeResearchPrompt(
  prefix = 'Before you generate the final implementation plan'
): string {
  return `${prefix}, capture every insight you've gathered.

Generate structured Markdown that preserves your research findings and provides a detailed implementation guide.
Be very exhaustive and think deeply when creating this content.

Your output should have two distinct sections:

## Research

This section preserves all the knowledge you gathered during exploration. The goal is to document your findings
so that anyone reading this later can understand what you learned without needing to re-explore the codebase.

Include:
- A concise overview of the opportunity or problem you investigated.
- The most critical discoveries that should guide implementation.
- Notable files, modules, or patterns you inspected and what you learned about them.
- Existing utilities, abstractions, or APIs that are relevant, with details on how to use them or references to existing documentation.
- Architectural hazards, edge cases, or constraints uncovered during research.
- Dependencies or prerequisites the implementation must respect.
- Any surprising findings or important context about the surrounding system.

Be verbose here. The insights you gathered are valuable, so include as much detail as possible from your exploration.
This section should serve as a standalone reference document for the research phase.

## Implementation Guide

This section provides actionable guidance for implementing the change.

Include:
- A detailed step-by-step guide on how to implement the change. This does not need to be actual code--the agent that
implements the code will be smart too--but each step should be very clear on what to do and why.
- Reference specific patterns, abstractions, APIs, and documentation files that are relevant to each step.
- Manual testing steps (these are appropriate here even though we don't want them in the structured tasks that you will generate later).
- Rationale behind why certain approaches are recommended over alternatives.

### Constraints

Do not wrap the output in code fences and do not repeat previous instructions.
File paths must be relative to the root of the repository, not absolute.
`;
}

export function generateClaudeCodeGenerationPrompt(
  planText: string,
  options: {
    includeMarkdownFormat?: boolean;
    withBlockingSubissues?: boolean;
  } = {}
): string {
  const { includeMarkdownFormat = true, withBlockingSubissues = false } = options;

  let formatInstructions: string;
  if (includeMarkdownFormat) {
    formatInstructions = `
Please output the plan in the exact Markdown format specified below:

${phaseBasedMarkdownExampleFormat}

Everything you said above will not be saved anywhere, so be sure to include it again when generating the plan below. Remember to include all the below sections in the project details, along with any other relevant details that an engineer will require to know how to implement the plan:
${commonGenerateDetails}`;
  } else {
    formatInstructions = `
Everything you said above will not be saved anywhere, so be sure to include it again when generating the plan below. Remember to include all the below sections in the project details, along with any other relevant details that an engineer will require to know how to implement the plan:
${commonGenerateDetails}`;
  }

  let projectReminder = planText
    ? `Once again, the project being implemented is:
${planText}
`
    : '';

  const blockingReminder = withBlockingSubissues
    ? `
In the plan's Details section, summarize any blocking plans you created under a "## Blocking Subissues" heading using this structure:
## Blocking Subissue: [Title]
- Priority: [high|medium|low|urgent]
- Reason: [Why this must be done first]
- Tasks: [High-level task list]

`
    : '';

  return `Based on your analysis of the codebase and the project description, please now generate a detailed implementation plan.

${projectReminder}

The plan should be formatted as follows:
- Break the project into phases (or a single phase for smaller features)
- Each phase should have a clear goal, details, and tasks
- Focus on logical progression and incremental functionality
- Include acceptance criteria for each phase

IMPORTANT: Do NOT create tasks for manual verification. This plan will be executed by an AI coding agent and verified separately after implementation. Focus on automated testing and implementation tasks only.

IMPORTANT: Testing should be INTEGRATED into your implementation tasks, not separate tasks. Each task that introduces new functionality should include writing tests as part of that task. Do NOT create standalone "Write tests" or "Add test coverage" tasks. Instead, ensure each implementation task description mentions the testing requirements for that specific feature.

${formatInstructions}

${blockingReminder}

Generate the complete plan now.`;
}

/**
 * Generates a follow-up prompt to ask the agent to create tasks if they weren't created
 * in the initial run. This is used for the single resume attempt.
 */
export function generateTaskCreationFollowUpPrompt(
  planPath: string,
  planId: number | string | undefined
): string {
  const planIdStr = planId !== undefined ? String(planId) : path.basename(planPath);

  return `You explored the codebase and wrote research/implementation guide, but did not create tasks for the plan.

Please review the implementation guide you wrote in the plan file at \`${planPath}\` and add tasks using the CLI command:

\`\`\`bash
echo '${JSON.stringify({
    plan: planIdStr,
    tasks: [
      { title: 'Task 1 Title', description: 'Task 1 description...' },
      { title: 'Task 2 Title', description: 'Task 2 description...' },
    ],
  })}' | tim tools update-plan-tasks
\`\`\`

Each task should have:
- **title**: A concise task title (one sentence)
- **description**: Detailed task description explaining what needs to be done

The list of tasks should correspond to the steps in your implementation guide.

IMPORTANT:
- Do NOT create tasks for manual verification. This plan will be executed by an AI coding agent.
- Testing should be INTEGRATED into implementation tasks, not separate tasks.

Please add the tasks now.`;
}
