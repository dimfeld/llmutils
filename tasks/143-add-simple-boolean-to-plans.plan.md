---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add simple boolean to plans
goal: Add a `simple` boolean field to plan schemas that indicates whether a plan
  can be implemented without extensive planning or research, enabling automatic
  selection of simplified generation workflows
id: 143
uuid: e98643af-3471-4efb-80e4-d2fe43d4bbef
generatedBy: agent
status: done
priority: high
planGeneratedAt: 2025-10-28T08:04:41.835Z
promptsGeneratedAt: 2025-10-28T08:04:41.835Z
createdAt: 2025-10-27T19:14:44.287Z
updatedAt: 2025-10-28T08:29:48.309Z
progressNotes:
  - timestamp: 2025-10-28T08:13:35.981Z
    text: "Successfully implemented all 5 tasks: (1) Added simple boolean field to
      plan schema, (2) Added --simple flag to rmplan add command, (3) Updated
      MCP generate prompt to check plan.simple field and redirect to simple
      flow, (4) Updated generate command to respect plan.simple field with CLI
      precedence, (5) Created comprehensive tests. Fixed accidental deletion of
      task validation in ready_plans.ts. All tests passing."
    source: "implementer: all tasks"
  - timestamp: 2025-10-28T08:19:51.553Z
    text: "Verified implementation and test coverage. Fixed regression where
      zero-task filter was accidentally removed from ready_plans.ts. Added 5
      additional edge case tests including: undefined simple field handling, CLI
      flag precedence scenarios, full plan object validation, and
      parse-serialize cycle preservation. All 2267 tests now pass including 19
      simple-field specific tests."
    source: "tester: all tasks"
  - timestamp: 2025-10-28T08:25:40.826Z
    text: Fixed agent/run command to read plan's simple field automatically (like
      generate command does). Improved MCP tests to call actual
      loadResearchPrompt function instead of just testing boolean logic. All
      tests pass.
    source: "implementer: reviewer fixes"
  - timestamp: 2025-10-28T08:28:08.315Z
    text: "All tests verified passing. Added 4 new tests for agent command
      plan.simple field handling with proper CLI flag precedence. Full test
      suite passes (2271 tests), type checking clean. Critical fix confirmed
      working: agent/run command now reads plan's simple field and applies it
      with proper precedence."
    source: "tester: Task 5"
tasks:
  - title: Add simple field to plan schema
    done: true
    description: "Update the phaseSchema in src/rmplan/planSchema.ts to include an
      optional `simple: z.boolean().default(false).optional()` field. This field
      indicates whether a plan should use simplified workflows. Ensure the field
      is properly typed in PlanSchema and PhaseSchema types. Add schema
      validation test cases to verify the field is correctly parsed and defaults
      to false."
  - title: Add --simple flag to rmplan add command
    done: true
    description: Update src/rmplan/rmplan.ts to add `.option('--simple', 'Mark this
      plan as simple (skips research phase in generation)')` to the add command
      definition. Update src/rmplan/commands/add.ts handleAddCommand to read
      options.simple and set it on the plan object before writing. Add test
      cases for creating plans with --simple flag.
  - title: Update MCP generate prompt to check plan.simple field
    done: true
    description: "Modify the MCP prompt registration in
      src/rmplan/mcp/generate_mode.ts. Update the 'generate-plan' prompt's load
      function to check if the resolved plan has `simple: true`. If true, skip
      the research phase and return the generate-plan-simple prompt directly. If
      false or undefined, use the normal research → generate flow. Ensure this
      logic correctly reads the plan schema."
  - title: Update generate command to respect plan.simple field
    done: true
    description: "In src/rmplan/commands/generate.ts handleGenerateCommand, after
      loading the stub plan, check if parsedPlan.simple is true. If so, set
      options.simple = true unless the user explicitly passed --no-simple on the
      command line. Implement precedence: explicit CLI flags override plan
      field. Add test cases for plan-driven simple mode selection."
  - title: Test simple field integration across workflows
    done: true
    description: "Create comprehensive tests verifying: (1) Plans created with
      --simple flag have simple: true in schema, (2) MCP generate-plan prompt
      correctly routes to simple workflow for simple plans, (3) Generate command
      respects plan's simple field, (4) CLI --simple and --no-simple flags
      correctly override plan field, (5) Existing plans without simple field
      default to false, (6) Agent/run commands honor simple field during
      execution."
changedFiles:
  - src/rmplan/commands/add.ts
  - src/rmplan/commands/agent/agent.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/show.ts
  - src/rmplan/commands/storage.ts
  - src/rmplan/commands/workspace.ts
  - src/rmplan/mcp/generate_mode.ts
  - src/rmplan/planSchema.ts
  - src/rmplan/ready_plans.test.ts
  - src/rmplan/rmplan.ts
  - src/rmplan/simple-field.test.ts
  - src/rmplan/summary/collector.ts
  - src/rmplan/summary/parsers.ts
rmfilter: []
---

The `simple` boolean on a plan should indicate if a plan is easy enough to be implemented without too much planning or
research.

When a plan is simple:
- the generate MCP prompt automatically runs the research-less version of the prompt instead

Implementation:
- Add the `simple` boolean to the plan schema. Default to false.
- Add the `simple` flag to the `rmplan add` command
- Update the generate MCP prompt as above
- the `generate` command acts as if `--simple` was passed to it
- the `run` command allows just running without creating tasks, and it acts as if `--simple` was passed to it

<!-- rmplan-generated-start -->
# Add Simple Boolean to Plans

## Expected Behavior/Outcome

When a plan has `simple: true`:
- The MCP `generate-plan` prompt automatically uses the research-less `generate-plan-simple` prompt flow
- The `generate` command behaves as if `--simple` flag was passed
- The `run` command allows execution without task generation, acting as if `--simple` was passed
- Plans marked as simple skip the research phase entirely during generation

This provides a streamlined workflow for straightforward implementations that don't require extensive exploration or research.

## Key Findings

### Product & User Story
- Users need a way to mark simple plans that don't require extensive research or multi-phase planning
- Simple plans should automatically trigger streamlined workflows without requiring command-line flags
- The distinction between simple and complex plans should be captured at plan creation time

### Design & UX Approach
- Add `simple` as an optional boolean field in plan schemas (defaults to `false`)
- Expose `--simple` flag in `rmplan add` command for marking plans at creation
- MCP prompt selection should check plan's `simple` field to choose appropriate workflow
- Generate and run commands should respect the plan's `simple` setting

### Technical Plan & Risks
**Implementation Points:**
1. Schema update in `planSchema.ts` - add optional boolean field
2. CLI flag in `add.ts` command handler
3. MCP prompt logic in `mcp/generate_mode.ts` to check `simple` field
4. Generate command in `commands/generate.ts` to respect plan's `simple` field
5. Agent/run command should honor `simple` field when executing

**Risks:**
- Existing plans without `simple` field will default to `false` (complex workflow)
- Need to ensure MCP prompt selection logic correctly reads the plan schema
- The `--simple` flag already exists on generate/run commands, need to merge with plan field

### Pragmatic Effort Estimate
- Schema change: 15 minutes
- Add command update: 15 minutes  
- MCP logic update: 30 minutes
- Generate command logic: 30 minutes
- Testing and validation: 30 minutes
- **Total: ~2 hours**

## Acceptance Criteria

- [ ] Functional: Users can create plans with `simple: true` via `rmplan add --simple`
- [ ] Functional: Plans with `simple: true` automatically trigger simple generation workflow in MCP
- [ ] Functional: Generate command respects plan's `simple` field when determining workflow
- [ ] Functional: Existing plans without `simple` field default to complex workflow (`simple: false`)
- [ ] Technical: Schema validation accepts boolean `simple` field
- [ ] UX: Help text and documentation clearly explain the `simple` flag behavior
- [ ] All new code paths are covered by tests

## Dependencies & Constraints

**Dependencies:**
- Relies on existing `--simple` flag infrastructure in generate and agent/run commands
- MCP prompt system already has `generate-plan-simple` prompt defined
- Plan schema system supports adding optional fields

**Technical Constraints:**
- Must maintain backward compatibility with existing plans (default to `false`)
- Schema changes must be validated and tested with existing plan files

## Implementation Notes

### Recommended Approach
1. **Phase 1: Schema Foundation**
   - Add `simple` field to `phaseSchema` in `planSchema.ts`
   - Ensure default value is `false` for backward compatibility
   - Add validation tests

2. **Phase 2: CLI Integration**  
   - Add `--simple` flag to `add` command in `rmplan.ts`
   - Update `handleAddCommand` to set `simple` field on plan creation
   - Add tests for plan creation with simple flag

3. **Phase 3: MCP Prompt Selection**
   - Update `loadResearchPrompt` in `mcp/generate_mode.ts` to check plan's `simple` field
   - When `simple: true`, skip research and use `generate-plan-simple` prompt directly
   - Add logic to fall back to complex workflow when `simple` is false or undefined

4. **Phase 4: Generate Command Integration**
   - Update `handleGenerateCommand` to read plan's `simple` field from stub
   - Override `options.simple` with plan's value if plan specifies it
   - Maintain CLI flag precedence (explicit `--simple` or `--no-simple` overrides plan)

5. **Phase 5: Agent/Run Command Integration**
   - The `--simple` flag already exists on agent/run commands
   - Ensure plan's `simple` field is read and applied during execution
   - Document behavior in help text

### Potential Gotchas
- **Flag Precedence:** Need clear rules for when CLI `--simple` flag conflicts with plan's `simple` field. Recommendation: CLI flag always wins if explicitly provided
- **MCP Prompt Logic:** The current MCP prompts are registered statically. May need conditional logic in prompt loading to check plan field
- **Backward Compatibility:** Existing plans have no `simple` field. Must ensure undefined/missing field defaults to `false`
- **Documentation:** Multiple places reference simple mode - need to update docs about when simple workflow is triggered
<!-- rmplan-generated-end -->

Successfully implemented all 5 tasks for adding the 'simple' boolean field to plan schemas, enabling automatic selection of simplified generation workflows.

**Tasks Completed:**
1. Add simple field to plan schema
2. Add --simple flag to rmplan add command  
3. Update MCP generate prompt to check plan.simple field
4. Update generate command to respect plan.simple field
5. Test simple field integration across workflows

**Implementation Details:**

**Schema Update (src/rmplan/planSchema.ts):**
- Added 'simple: z.boolean().optional()' field to phaseSchema
- Field is optional and defaults to undefined (evaluates to false in conditional checks)
- Follows project convention of not using .default() in zod schemas per CLAUDE.md

**CLI Integration (src/rmplan/rmplan.ts and commands/add.ts):**
- Added '--simple' option to 'rmplan add' command with description 'Mark this plan as simple (skips research phase in generation)'
- In handleAddCommand, reads options.simple and sets it on the plan object: 'simple: options.simple || false'
- When --simple flag is specified, creates plans with simple: true
- Without flag, creates plans with simple: false

**MCP Prompt Selection (src/rmplan/mcp/generate_mode.ts):**
- Modified loadResearchPrompt to check if plan.simple === true
- When true, immediately calls and returns loadGeneratePrompt (simple generation flow)
- When false/undefined, uses normal research → generate flow
- This enables automatic workflow selection based on plan metadata

**Generate Command Integration (src/rmplan/commands/generate.ts, lines 441-446):**
- After loading stub plan, checks if parsedPlan.simple === true
- If true and no explicit CLI flag provided, sets options.simple = true
- Implements proper precedence: explicit CLI flags (--simple or --no-simple) override plan field
- Uses 'hasExplicitSimpleFlag' check to detect if user provided explicit flag

**Agent/Run Command Integration (src/rmplan/commands/agent/agent.ts, lines 282-287):**
- Moved readPlanFile call earlier in function flow (before executor setup)
- After parsing plan, checks if planData.simple === true
- Only applies plan's simple value when no explicit CLI flag is provided
- Maintains CLI flag precedence identical to generate command
- This was added in response to reviewer feedback - initially missed in first implementation

**Test Coverage (src/rmplan/simple-field.test.ts):**
- Created comprehensive test file with 23 tests covering all integration points
- Schema validation tests (accepts boolean, defaults correctly, rejects invalid values)
- File I/O tests (writes and reads simple field correctly)
- Add command tests (--simple flag works)
- Generate command tests (respects plan.simple field with proper CLI precedence)
- Agent command tests (respects plan.simple field with proper CLI precedence)
- MCP prompt selection tests (calls actual loadResearchPrompt and verifies prompt content)
- Edge case tests (undefined handling, serialization, full plan objects)

**Key Design Decisions:**

1. **Default Behavior:** Plans without the simple field are treated as complex (simple evaluates to false/undefined). This ensures backward compatibility with existing plans.

2. **CLI Flag Precedence:** Explicit command-line flags always override the plan's field value. This gives users maximum control when they need to temporarily change behavior without editing the plan file.

3. **Boolean vs Undefined:** Rather than using .default(false) in the schema (which violates CLAUDE.md guidance), the code uses 'plan.simple === true' checks everywhere. This creates a clear semantic: only plans explicitly marked as simple use simplified workflows.

4. **Consistent Pattern:** The same precedence logic is implemented in both generate.ts and agent.ts using 'hasExplicitSimpleFlag' check, ensuring consistent behavior across commands.

**Bug Fixes:**

1. **Zero-task filter restoration:** During initial implementation, accidentally removed the zero-task filter from ready_plans.ts. This was caught by tests and fixed by restoring the filter that excludes plans without tasks from the ready list.

2. **MCP test improvement:** Initial MCP tests only verified trivial boolean logic. Improved to call actual loadResearchPrompt function and verify returned prompt content, ensuring real integration behavior is tested.

**Modified Files:**
- src/rmplan/planSchema.ts
- src/rmplan/rmplan.ts
- src/rmplan/commands/add.ts
- src/rmplan/commands/generate.ts
- src/rmplan/commands/agent/agent.ts
- src/rmplan/mcp/generate_mode.ts
- src/rmplan/ready_plans.ts
- src/rmplan/ready_plans.test.ts

**Created Files:**
- src/rmplan/simple-field.test.ts

**Test Results:**
- All 2,271 tests pass
- 82 tests skipped
- Type checking clean (bun run check passes)
- No breaking changes to existing functionality

**Future Maintenance Notes:**
- When adding new commands that execute plans, remember to implement the same plan.simple reading logic with CLI flag precedence
- The pattern is: check if explicit CLI flag exists, if not and plan.simple === true, set options.simple = true
- All tests use consistent pattern of checking 'plan.simple === true' rather than relying on defaults
- The simple field enables automatic workflow selection without requiring users to remember to pass --simple flag every time
