---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: add ability to add a progress note to a plan
goal: Enable agents to add timestamped progress notes to plans during execution,
  providing an audit trail of significant work completion, unexpected behaviors,
  and important discoveries that persist across plan updates and appear in agent
  prompts.
id: 121
uuid: 0109ad0b-e71c-4301-9979-666c7fe6d859
generatedBy: agent
status: done
priority: medium
dependencies: []
issue: []
docs: []
planGeneratedAt: 2025-09-15T08:23:05.434Z
createdAt: 2025-09-15T03:02:03.721Z
updatedAt: 2025-10-27T08:39:04.221Z
tasks:
  - title: Extend Plan Schema
    done: true
    description: >
      Add progressNotes field to phaseSchema in `src/rmplan/planSchema.ts` after
      line 35 with other array fields:

      ```typescript

      progressNotes: z.array(z.object({
        timestamp: z.string().datetime(),
        text: z.string()
      })).default([]).optional()

      ```
    steps: []
  - title: Regenerate JSON Schema
    done: true
    description: Run `bun run scripts/update-json-schemas.ts` to regenerate the JSON
      schema file that provides IDE support for plan files.
    steps: []
  - title: Add Schema Validation Tests
    done: true
    description: |
      Create tests in `src/rmplan/planSchema.test.ts` to validate:
      - Plans with valid progress notes are accepted
      - Invalid timestamp formats are rejected
      - Missing required fields are caught
      - Empty arrays are handled correctly
      - Backward compatibility with plans lacking progressNotes
    steps: []
  - title: Create Command Handler
    done: true
    description: |
      Create `src/rmplan/commands/add-progress-note.ts` with:
      - Interface for command options
      - Handler function that loads plan, adds note, saves plan
      - Proper error handling and user feedback
      - Integration with plan resolution and config loading
    steps: []
  - title: Register Command in CLI
    done: true
    description: >
      Add command registration to `src/rmplan/rmplan.ts`:

      ```typescript

      .command('add-progress-note <planFile> <note>')

      .description('Add a progress note to a plan')

      .action(async (planFile, note, command) => {
        const { handleAddProgressNoteCommand } = await import('./commands/add-progress-note.js');
        await handleAddProgressNoteCommand(planFile, note, command).catch(handleCommandError);
      })

      ```
    steps: []
  - title: Write Command Tests
    done: true
    description: |
      Create `src/rmplan/commands/add-progress-note.test.ts` with tests for:
      - Adding notes to existing plans
      - Handling non-existent plan files
      - Preserving existing notes when adding new ones
      - Proper timestamp formatting
      - Error handling for invalid inputs
    steps: []
  - title: Add Progress Notes to Prompt Builder
    done: true
    description: |
      Modify `src/rmplan/prompt_builder.ts`:
      - Create `buildProgressNotesSection()` function
      - Include notes in `buildExecutionPromptWithoutSteps()` after plan context
      - Format notes with timestamps and proper markdown
      - Handle empty notes array gracefully
    steps: []
  - title: Update Show Command
    done: true
    description: |
      Modify `src/rmplan/commands/show.ts`:
      - Display progress notes section when notes exist
      - Format with timestamps and indentation
      - Show note count in summary
      - Handle long notes with appropriate truncation
    steps: []
  - title: Update List Command
    done: true
    description: |
      Modify `src/rmplan/commands/list.ts`:
      - Add progress note count to plan listings
      - Only show count when notes exist
      - Maintain clean output format
    steps: []
  - title: Update Agent Documentation
    done: true
    description: |
      Modify executor prompts to document progress note capability:
      - Update `src/rmplan/executors/claude_code/orchestrator_prompt.ts`
      - Add instructions for when to use progress notes
      - Include example of adding progress notes
    steps: []
  - title: Write Integration Tests
    done: true
    description: |
      Create integration tests that verify:
      - Progress notes flow from command to file to display
      - Notes appear correctly in agent prompts
      - Multiple agents can add notes without conflicts
      - Notes persist through plan updates
    steps: []
  - title: Test Plan Operations Compatibility
    done: true
    description: |
      Ensure progress notes work with:
      - Plan splitting (notes stay with parent)
      - Plan merging (notes are combined)
      - Plan inheritance (notes are preserved)
      - Plan validation and cleanup
    steps: []
  - title: Handle Edge Cases
    done: true
    description: |
      Test and fix edge cases:
      - Very long note text (implement truncation if needed)
      - Special characters in note text
      - Concurrent note additions
      - Maximum number of notes (implement rotation if needed)
      - Notes with multi-line text
    steps: []
  - title: Update Documentation
    done: true
    description: |
      Update README and relevant documentation:
      - Add progress notes to feature list
      - Document `add-progress-note` command usage
      - Provide examples of when agents should add notes
      - Include progress notes in workflow examples
    steps: []
changedFiles:
  - README.md
  - schema/rmplan-plan-schema.json
  - src/rmplan/commands/add-progress-note.merge.test.ts
  - src/rmplan/commands/add-progress-note.rotation.test.ts
  - src/rmplan/commands/add-progress-note.test.ts
  - src/rmplan/commands/add-progress-note.ts
  - src/rmplan/commands/list.progress_notes.test.ts
  - src/rmplan/commands/list.test.ts
  - src/rmplan/commands/list.ts
  - src/rmplan/commands/merge.test.ts
  - src/rmplan/commands/merge.ts
  - src/rmplan/commands/show.test.ts
  - src/rmplan/commands/show.ts
  - src/rmplan/commands/split.test.ts
  - src/rmplan/configSchema.ts
  - src/rmplan/executors/claude_code/orchestrator_prompt.test.ts
  - src/rmplan/executors/claude_code/orchestrator_prompt.ts
  - src/rmplan/planSchema.test.ts
  - src/rmplan/planSchema.ts
  - src/rmplan/progress_notes.edge_cases.test.ts
  - src/rmplan/progress_notes.integration.test.ts
  - src/rmplan/prompt.ts
  - src/rmplan/prompt_builder.test.ts
  - src/rmplan/prompt_builder.ts
  - src/rmplan/rmplan.ts
  - src/rmplan/truncation.test.ts
  - src/rmplan/truncation.ts
rmfilter: []
---

# Original Plan Details

Agents should be able to add progress notes to plans as they run, to describe what they have done so far and any
interesting notes.

Each progress note should contain the following:
- current timestamp
- text of the note

- Add a new optional array of progress notes to the plan schema called progressNotes
- Add a new command `add-progress-note` to rmplan similar to `set-task-done` that can add a string to the progressNotes array for a plan
- Update the prompts to indicate that it should be used to add progress notes 
- When building the agent prompts, include the progress notes from the current plan in the prompt

Sample execution:
`rmplan add-progress-note "<text>"`

Progress notes should be added when:
- Significant chunks of work are done
- Unexpected behavior occurs and the implementation deviates from the plan
- The agent discovers something Unexpected

A progress note should contain enough details in its text that it can be understood by just looking at the notes
and the plan. Readers won't know what was happening when you wrote the note unless you include those details.

# Processed Plan Details

## Add Progress Notes Feature to rmplan for Agent Execution Tracking

Agents currently lack a mechanism to document their progress and decisions during execution, making it difficult to understand what happened during complex plan runs. This feature adds progress notes as a first-class concept in the plan schema, allowing both automated agents and human operators to add timestamped notes that provide context about execution history.

### Expected Behavior/Outcome
- Agents can add progress notes via `rmplan add-progress-note <plan> "<text>"` command
- Progress notes persist in plan YAML files as an array at the plan level
- Each note contains a timestamp (ISO datetime) and text content
- Notes appear in agent prompts to provide execution context
- Notes are displayed in `rmplan show` output and counted in `rmplan list`
- Notes accumulate chronologically and persist across plan operations

### Key Findings
- **Product & User Story**: Agents need to document significant chunks of work, unexpected behaviors, and deviations from the plan. Users need visibility into what agents discovered and why they made certain decisions.
- **Design & UX Approach**: Minimal CLI interface following existing command patterns. Non-intrusive display showing notes only when present. Chronological organization for clear progression tracking.
- **Technical Plan & Risks**: Extend plan schema with optional array field. Integrate into prompt building and display commands. Risk of prompt size inflation with many notes - mitigate with truncation if needed.
- **Pragmatic Effort Estimate**: 6-9 hours total (4-6 hours implementation, 2-3 hours testing/refinement)

### Acceptance Criteria
- [ ] Agents can call `rmplan add-progress-note` to add timestamped notes to plans
- [ ] Progress notes persist in plan YAML files and survive plan updates
- [ ] Notes appear in `rmplan show` output with timestamps and formatted text
- [ ] Agent prompts include progress notes section when notes exist. Prompt does not include note timestamps
- [ ] Schema validation ensures proper note structure
- [ ] All new code paths are covered by comprehensive tests

### Dependencies & Constraints
- **Dependencies**: Plan schema system, plan file I/O utilities, command registration system, prompt building system
- **Technical Constraints**: Must maintain backward compatibility with existing plan files. Notes must be preserved during plan operations (split, merge, inheritance). Should not significantly increase prompt size.

### Implementation Notes
- **Recommended Approach**: Incremental implementation starting with schema, then command, then integration points
- **Potential Gotchas**: Timestamp format consistency, concurrent updates from multiple agents, special character escaping in note text, preservation during plan inheritance

---

## Area 1: Schema and Data Model Foundation

Tasks:
- Extend Plan Schema
- Regenerate JSON Schema
- Add Schema Validation Tests

Add the progressNotes field to the plan schema as an optional array of structured objects containing timestamp and text. This foundational change enables all subsequent functionality. The schema must be backward compatible, allowing existing plans to continue working without modification.

### Acceptance Criteria
- [ ] Schema includes progressNotes field with timestamp and text validation
- [ ] Existing plan files remain valid without progressNotes field
- [ ] JSON schema is regenerated and includes progressNotes definition
- [ ] TypeScript types are properly inferred from Zod schema
- [ ] Schema validation tests pass for valid and invalid note structures

---

## Area 2: Command Implementation

Tasks:
- Create Command Handler
- Register Command in CLI
- Write Command Tests

Create a new command following the established pattern from commands like `set-task-done`. The command should load the plan file, add a timestamped note to the progressNotes array, and save the updated plan. The command must handle edge cases like non-existent plans and provide clear feedback.

### Acceptance Criteria
- [ ] Command is registered in rmplan.ts with proper options
- [ ] Command handler validates inputs and provides clear error messages
- [ ] Progress notes are added with current timestamp
- [ ] Plan file is correctly updated and saved
- [ ] Command tests cover success and error cases

---

## Area 3: Agent Integration and Display

Tasks:
- Add Progress Notes to Prompt Builder
- Update Show Command
- Update List Command
- Update Agent Documentation

Progress notes must be included in agent execution prompts to provide context about previous execution. They should also be displayed when viewing plans. The integration must handle formatting, truncation for large note collections, and proper markdown rendering in prompts.

### Acceptance Criteria
- [ ] Progress notes appear in execution prompts via buildExecutionPromptWithoutSteps
- [ ] Notes are formatted without timestamps in agent prompts
- [ ] `rmplan show` displays progress notes when present
- [ ] `rmplan list` shows count of progress notes
- [ ] Batch mode includes progress notes context
- [ ] Agent documentation mentions progress note capability

---

## Area 4: Testing and Edge Cases

Tasks:
- Write Integration Tests
- Test Plan Operations Compatibility
- Handle Edge Cases
- Update Documentation

Complete the implementation with thorough testing of all components and edge cases. Ensure progress notes work correctly with other plan operations like splitting, merging, and inheritance. Test display formatting and prompt integration thoroughly.

### Acceptance Criteria
- [ ] Integration tests verify end-to-end functionality
- [ ] Progress notes survive plan split and merge operations
- [ ] Display tests verify correct formatting
- [ ] Prompt tests confirm notes appear in agent context
- [ ] Edge cases like special characters are handled
- [ ] Documentation is updated with feature usage
