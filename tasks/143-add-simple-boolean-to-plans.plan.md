---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add simple boolean to plans
goal: Add a `simple` boolean field to plan schemas that indicates whether a plan
  can be implemented without extensive planning or research, enabling automatic
  selection of simplified generation workflows
id: 143
uuid: e98643af-3471-4efb-80e4-d2fe43d4bbef
generatedBy: agent
status: in_progress
priority: high
container: false
temp: false
dependencies: []
issue: []
pullRequest: []
docs: []
planGeneratedAt: 2025-10-28T08:04:41.835Z
promptsGeneratedAt: 2025-10-28T08:04:41.835Z
createdAt: 2025-10-27T19:14:44.287Z
updatedAt: 2025-10-28T08:13:35.984Z
progressNotes:
  - timestamp: 2025-10-28T08:13:35.981Z
    text: "Successfully implemented all 5 tasks: (1) Added simple boolean field to
      plan schema, (2) Added --simple flag to rmplan add command, (3) Updated
      MCP generate prompt to check plan.simple field and redirect to simple
      flow, (4) Updated generate command to respect plan.simple field with CLI
      precedence, (5) Created comprehensive tests. Fixed accidental deletion of
      task validation in ready_plans.ts. All tests passing."
    source: "implementer: all tasks"
tasks:
  - title: Add simple field to plan schema
    done: false
    description: "Update the phaseSchema in src/rmplan/planSchema.ts to include an
      optional `simple: z.boolean().default(false).optional()` field. This field
      indicates whether a plan should use simplified workflows. Ensure the field
      is properly typed in PlanSchema and PhaseSchema types. Add schema
      validation test cases to verify the field is correctly parsed and defaults
      to false."
    files: []
    docs: []
    steps: []
  - title: Add --simple flag to rmplan add command
    done: false
    description: Update src/rmplan/rmplan.ts to add `.option('--simple', 'Mark this
      plan as simple (skips research phase in generation)')` to the add command
      definition. Update src/rmplan/commands/add.ts handleAddCommand to read
      options.simple and set it on the plan object before writing. Add test
      cases for creating plans with --simple flag.
    files: []
    docs: []
    steps: []
  - title: Update MCP generate prompt to check plan.simple field
    done: false
    description: "Modify the MCP prompt registration in
      src/rmplan/mcp/generate_mode.ts. Update the 'generate-plan' prompt's load
      function to check if the resolved plan has `simple: true`. If true, skip
      the research phase and return the generate-plan-simple prompt directly. If
      false or undefined, use the normal research → generate flow. Ensure this
      logic correctly reads the plan schema."
    files: []
    docs: []
    steps: []
  - title: Update generate command to respect plan.simple field
    done: false
    description: "In src/rmplan/commands/generate.ts handleGenerateCommand, after
      loading the stub plan, check if parsedPlan.simple is true. If so, set
      options.simple = true unless the user explicitly passed --no-simple on the
      command line. Implement precedence: explicit CLI flags override plan
      field. Add test cases for plan-driven simple mode selection."
    files: []
    docs: []
    steps: []
  - title: Test simple field integration across workflows
    done: false
    description: "Create comprehensive tests verifying: (1) Plans created with
      --simple flag have simple: true in schema, (2) MCP generate-plan prompt
      correctly routes to simple workflow for simple plans, (3) Generate command
      respects plan's simple field, (4) CLI --simple and --no-simple flags
      correctly override plan field, (5) Existing plans without simple field
      default to false, (6) Agent/run commands honor simple field during
      execution."
    files: []
    docs: []
    steps: []
changedFiles: []
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
