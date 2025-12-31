---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Update generate process to retain more of the planning output
goal: Modify the rmplan generate and prepare commands to use a three-step Claude
  Code process that preserves the research and analysis done during planning by
  appending it to the plan file under a "## Research" heading before final plan
  generation.
id: 124
uuid: f7cf2f1c-749c-4c69-ad3a-2928f41daf66
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2025-09-24T09:57:35.920Z
createdAt: 2025-09-24T09:46:07.509Z
updatedAt: 2025-10-27T08:39:04.251Z
tasks:
  - title: Modify Claude Code orchestrator for three-step flow
    done: true
    description: Update `/src/rmplan/executors/claude_code_orchestrator.ts` to
      accept an optional research extraction prompt parameter. Implement
      conditional execution that runs the research prompt between planning and
      generation when provided, maintaining session state across all three
      steps.
  - title: Create research extraction prompt template
    done: true
    description: Add a new prompt function `generateClaudeCodeResearchPrompt()` to
      `/src/rmplan/prompt.ts` that instructs Claude to format and output all
      research findings in a structured markdown format suitable for appending
      to the plan file.
  - title: Update orchestrator response handling
    done: true
    description: Enhance the JSON stream processing in the orchestrator to capture
      research output separately from the final plan output, ensuring proper
      formatting and error handling for the intermediate research step.
  - title: Update generate command for three-step flow
    done: true
    description: Modify `/src/rmplan/commands/generate.ts` to always use the
      three-step process when in Claude mode. Update the
      `invokeClaudeCodeForGeneration` wrapper in `/src/rmplan/claude_utils.ts`
      to pass the research prompt to the orchestrator.
  - title: Add conditional research extraction to prepare command
    done: true
    description: Update `/src/rmplan/commands/prepare.ts` to check the plan's
      `generatedBy` field and conditionally include the research extraction step
      for 'oneshot' plans. Ensure proper plan file reading and updating with
      research content.
  - title: Implement research content insertion logic
    done: true
    description: Create a utility function to append research findings to the plan's
      details field with proper formatting, timestamps, and markdown structure.
      Ensure the research section is preserved during subsequent plan updates.
  - title: Create orchestrator unit tests
    done: true
    description: Write comprehensive unit tests for the modified orchestrator in
      `/src/rmplan/executors/claude_code_orchestrator.test.ts`, covering
      successful three-step flow, two-step fallback, and error scenarios.
  - title: Add integration tests for commands
    done: true
    description: Create integration tests for generate and prepare commands that
      verify research extraction behavior, including tests for the conditional
      logic based on generatedBy field and proper plan file updates.
  - title: Test edge cases and error recovery
    done: true
    description: Implement tests for edge cases including research extraction
      failures, malformed outputs, session interruptions, and verify graceful
      degradation to two-step flow when needed.
  - title: Update documentation
    done: true
    description: Update CLAUDE.md and relevant documentation to describe the new
      three-step process, when research extraction occurs, and how to access
      preserved research findings in plan files.
changedFiles:
  - CLAUDE.md
  - README.md
  - src/rmplan/claude_utils.test.ts
  - src/rmplan/claude_utils.ts
  - src/rmplan/commands/generate.test.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/research.test.ts
  - src/rmplan/commands/research.ts
  - src/rmplan/executors/claude_code_orchestrator.test.ts
  - src/rmplan/executors/claude_code_orchestrator.ts
  - src/rmplan/plans/prepare_phase.test.ts
  - src/rmplan/plans/prepare_phase.ts
  - src/rmplan/process_markdown.ts
  - src/rmplan/prompt.ts
  - src/rmplan/research_utils.test.ts
  - src/rmplan/research_utils.ts
rmfilter: []
---

# Original Plan Details

The generate process does a lot of research into the repository about how things work but a lot of that is lost when it
is distilled into the plan. We should update the claude code generation to have a three-step process:

1. The existing first prompt that does the generate.
2. An optional second prompt which tells Claude to append all of its findings into the plan file under a "## Research" heading
3. The existing second prompt (now the third) which tells it to generate the plan

The optional second prompt will be run for:
- the generate command always
- the prepare command if the plan's `generatedBy` field is `oneshot`

Then after that, we can reread the plan file and process the markdown into tasks like we do now.

# Processed Plan Details

## Update rmplan generate process to retain planning research output in a dedicated Research section

The current two-step Claude Code generation process performs extensive codebase research during the planning phase, but this valuable context is lost when distilled into the final plan. This enhancement adds an optional intermediate step to capture and preserve these findings, making them available for future reference and providing better context for implementation.

### Expected Behavior/Outcome
- The generate command always uses a three-step process: planning → research extraction → generation
- The prepare command conditionally uses the research extraction step based on the plan's `generatedBy` field
- Research findings are preserved in the plan file under a "## Research" heading
- The research section is included in the plan's details field and persists through plan updates
- All existing two-step workflows continue to function without modification

### Key Findings
- **Product & User Story**: Engineers lose valuable context when planning research isn't preserved. Having research findings available during implementation improves decision-making and reduces re-discovery of architectural patterns.
- **Design & UX Approach**: Research content is appended to the plan file in a structured markdown section, maintaining readability while preserving context. The three-step process is transparent to users in direct/Claude modes.
- **Technical Plan & Risks**: Leverage existing session resumption in Claude Code orchestrator. Main risk is ensuring backward compatibility for existing workflows. The approach uses conditional logic to maintain two-step flow when appropriate.
- **Pragmatic Effort Estimate**: 4-6 hours of implementation, 2-3 hours of testing

### Acceptance Criteria
- [ ] Generate command performs three-step process with research extraction
- [ ] Prepare command conditionally performs research extraction for oneshot plans
- [ ] Research findings are properly formatted and appended to plan files
- [ ] Existing two-step workflows remain functional
- [ ] Research section persists through plan updates and modifications
- [ ] All new code paths are covered by tests
- [ ] Error handling gracefully falls back to two-step process if research extraction fails

### Dependencies & Constraints
- **Dependencies**: Existing Claude Code orchestrator session management, plan file reading/writing infrastructure
- **Technical Constraints**: Must maintain backward compatibility with existing plans, research section must not interfere with task extraction

### Implementation Notes
- **Recommended Approach**: Add optional third prompt parameter to orchestrator, conditionally execute based on command context
- **Potential Gotchas**: Session state management between three prompts, handling research extraction failures gracefully, ensuring research doesn't break YAML parsing

---

## Area 1: Core Three-Step Orchestration Implementation

Tasks:
- Modify Claude Code orchestrator for three-step flow
- Create research extraction prompt template
- Update orchestrator response handling

Modify the Claude Code orchestrator to support an optional middle step for research extraction. This phase focuses on the core orchestration logic without command integration, establishing the foundation for the three-step workflow.

### Acceptance Criteria
- [ ] Orchestrator accepts optional research extraction prompt
- [ ] Session continuity maintained across three prompts
- [ ] Research output properly captured and returned
- [ ] Two-step flow remains functional when research prompt is omitted
- [ ] Error handling for research extraction failures

---

## Area 2: Command Integration and Conditional Logic

Tasks:
- Update generate command for three-step flow
- Add conditional research extraction to prepare command
- Implement research content insertion logic

Update the generate and prepare commands to utilize the three-step orchestration. Generate command always uses three steps, while prepare command conditionally uses research extraction based on the plan's `generatedBy` field being 'oneshot'.

### Acceptance Criteria
- [ ] Generate command always performs three-step process
- [ ] Prepare command checks generatedBy field and conditionally adds research step
- [ ] Research content properly appended to plan file under "## Research" heading
- [ ] Plan file re-read and processed after research insertion
- [ ] Existing command options and flags continue to work

---

## Area 3: Testing and Edge Case Handling

Tasks:
- Create orchestrator unit tests
- Add integration tests for commands
- Test edge cases and error recovery
- Update documentation

Create comprehensive tests for the new three-step workflow, ensuring backward compatibility and proper error handling. Address edge cases such as research extraction failures, malformed research output, and plan file update conflicts.

### Acceptance Criteria
- [ ] Unit tests for orchestrator three-step flow
- [ ] Integration tests for generate command with research
- [ ] Integration tests for prepare command conditional logic
- [ ] Tests for research content formatting and insertion
- [ ] Tests for error recovery and fallback behavior
- [ ] Manual testing of end-to-end workflows
