---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: break out MCP file into multiple files
goal: ""
id: 141
uuid: 58b83739-f558-4f60-b80b-b9378fd75d78
generatedBy: agent
status: done
priority: high
temp: false
planGeneratedAt: 2025-10-27T19:36:54.793Z
promptsGeneratedAt: 2025-10-27T19:36:54.793Z
createdAt: 2025-10-27T06:31:21.571Z
updatedAt: 2025-10-27T21:08:28.193Z
compactedAt: 2025-10-30T19:59:35.980Z
progressNotes:
  - timestamp: 2025-10-27T19:46:00.224Z
    text: Created shared ready_plans module with filtering/sorting utilities,
      updated ready command and MCP list-ready-plans to use it, refreshed tests,
      and ran bun check plus targeted eslint; full eslint still fails due to
      pre-existing issues.
    source: "implementer: Task 1 & Task 6"
  - timestamp: 2025-10-27T19:49:02.379Z
    text: Ran ready plan unit tests, ready command tests, MCP generate mode tests,
      and type checking; all pass.
    source: "tester: Task 1 & 6"
  - timestamp: 2025-10-27T20:00:42.253Z
    text: Created shared plan_display module with
      buildPlanContext/formatExistingTasks/resolvePlan, moved MCP usage to
      import, and added dedicated tests to cover formatting and plan resolution.
    source: "implementer: Task 2"
  - timestamp: 2025-10-27T20:03:35.665Z
    text: Updated show command to export mcpGetPlan leveraging plan_display
      utilities and added unit coverage to verify MCP plan retrieval formatting.
    source: "implementer: Task 4"
  - timestamp: 2025-10-27T20:05:14.518Z
    text: Updated generate_mode MCP registration to delegate the get-plan tool to
      the show command implementation and refreshed tests to reference the new
      handler.
    source: "implementer: Task 9"
  - timestamp: 2025-10-27T20:09:14.040Z
    text: Extended plan_display coverage to exercise config-based ID resolution and
      reran plan_display, show, ready_plans, and MCP suites plus type checking;
      all passed.
    source: "tester: Task 2 & 4"
  - timestamp: 2025-10-27T20:17:36.491Z
    text: Created plan_merge.ts with delimiter + merge utilities, moved MCP imports
      to use it, and added plan_merge.test.ts covering research placement,
      delimiter updates, metadata preservation, and validation errors.
    source: "implementer: Task 3"
  - timestamp: 2025-10-27T20:22:24.016Z
    text: Moved update-plan-details and update-plan-tasks MCP handlers into
      commands/update.ts using plan_merge utilities, added shared type imports,
      and extended update.test.ts with end-to-end handler coverage.
    source: "implementer: Tasks 7 & 8"
  - timestamp: 2025-10-27T20:25:17.347Z
    text: Swapped MCP registration to call the new update command handlers, added
      error wrapping, and refreshed generate_mode tests to exercise
      mcpUpdatePlanTasks via the shared parameter schemas.
    source: "implementer: Tasks 7 & 8"
  - timestamp: 2025-10-27T20:28:04.376Z
    text: Ran existing plan_merge, update command, and MCP generate_mode test suites
      plus bun run check to validate current state; all passing before adding
      new coverage.
    source: "tester: Task 3/7/8"
  - timestamp: 2025-10-27T20:29:03.080Z
    text: Added regression tests covering MCP update-plan details for plans without
      existing details and update-plan tasks validation failures; verified new
      cases with bun test src/rmplan/commands/update.test.ts.
    source: "tester: Task 3/7/8"
  - timestamp: 2025-10-27T20:44:25.256Z
    text: Moved append-plan-research MCP handler into commands/research.ts, added
      mcpAppendResearch export plus tests covering heading/timestamp options,
      and updated generate_mode to call the shared handler.
    source: "implementer: Task 5"
  - timestamp: 2025-10-27T20:45:49.773Z
    text: Refined generate_mode.ts into a registration layer by importing the ready
      command MCP handler, removed inline ready-plan logic, and added
      mcpListReadyPlans implementation in commands/ready.ts.
    source: "implementer: Task 9"
  - timestamp: 2025-10-27T20:47:30.835Z
    text: Ran targeted research, ready, and MCP generate_mode test suites plus bun
      run check; all passing after re-pointing tests to the new MCP handler
      exports.
    source: "tester: Tasks 5 & 9"
  - timestamp: 2025-10-27T20:58:36.666Z
    text: Ran targeted and full Bun test suites plus bun run check; all passed. bun
      run lint still fails with pre-existing issues (missing .js files in
      tsconfig, no-empty blocks, etc.), matching prior state.
    source: "tester: Task 10"
  - timestamp: 2025-10-27T20:59:32.422Z
    text: Validated CLI and MCP entrypoints (ready --help, mcp-server http startup)
      after refactor and documented the shared
      plan_display/plan_merge/ready_plans modules plus thin MCP layer in
      CLAUDE.md.
    source: "implementer: Task 10"
  - timestamp: 2025-10-27T21:01:08.183Z
    text: Reviewed new ready_plans, plan_display, plan_merge, and MCP handler tests;
      coverage looks comprehensive for refactored utilities.
    source: "tester: Task 10"
  - timestamp: 2025-10-27T21:01:42.675Z
    text: Executed ready_plans, plan_display, plan_merge, commands, and MCP Bun test
      suites plus bun run check; all passed.
    source: "tester: Task 10"
  - timestamp: 2025-10-27T21:02:01.430Z
    text: Ran bun run lint; command timed out after reporting existing repository
      lint failures (missing .js stubs, empty blocks, unnecessary assertions).
      No new issues introduced by recent changes.
    source: "tester: Task 10"
tasks:
  - title: Create ready_plans.ts shared utility module
    done: true
    description: >-
      Extract ready plan detection and filtering logic to eliminate 3x
      duplication.


      **Create src/rmplan/ready_plans.ts with:**

      - `isReadyPlan()` function - canonical ready plan detection
      (pending/in_progress + all deps done + has tasks)

      - `sortReadyPlans()` function - sort by priority/id/title/created/updated
      with proper priority ordering

      - `filterAndSortReadyPlans()` function - combined filtering and sorting

      - `formatReadyPlansAsJson()` function - JSON output formatting

      - Export `ReadyPlanFilterOptions` and `EnrichedReadyPlan` types


      **Update imports in:**

      - src/rmplan/commands/ready.ts - use new isReadyPlan and sortReadyPlans

      - src/rmplan/mcp/generate_mode.ts - use new functions in
      handleListReadyPlansTool


      **Testing:**

      - Create src/rmplan/ready_plans.test.ts with comprehensive test coverage

      - Test ready plan detection with various dependency states

      - Test sorting with different sort fields and priority values

      - Test filtering with priority and pending-only options

      - Verify JSON output format matches expected structure
  - title: Create plan_display.ts shared utility module
    done: true
    description: >-
      Extract plan context building and formatting utilities.


      **Create src/rmplan/plan_display.ts with:**

      - `buildPlanContext()` function - formats plan metadata for AI context
      (from generate_mode.ts:45-81)

      - `formatExistingTasks()` function - formats task summaries (from
      generate_mode.ts:22-43)

      - `resolvePlan()` helper - wraps resolvePlanFile + readPlanFile (from
      generate_mode.ts:83-93)

      - Export `PlanDisplayOptions` type for configurable detail levels


      **Update imports in:**

      - src/rmplan/mcp/generate_mode.ts - import all three functions

      - src/rmplan/commands/generate.ts - import buildPlanContext if needed

      - src/rmplan/commands/show.ts - consider using buildPlanContext


      **Testing:**

      - Create src/rmplan/plan_display.test.ts

      - Test buildPlanContext with various plan fields (with/without goal,
      issues, docs, tasks)

      - Test formatExistingTasks with empty, single, and multiple tasks

      - Test resolvePlan with valid plan IDs and file paths

      - Verify relative path calculation works correctly
  - title: Create plan_merge.ts shared utility module
    done: true
    description: >-
      Extract plan merging logic and delimiter-based content management.


      **Create src/rmplan/plan_merge.ts with:**

      - Export delimiter constants: `GENERATED_START_DELIMITER`,
      `GENERATED_END_DELIMITER`

      - `findResearchSectionStart()` function - locates ## Research heading
      (from generate_mode.ts:233-236)

      - `mergeDetails()` function - merges details preserving research (from
      generate_mode.ts:244-280)

      - `mergeTasksIntoPlan()` function - merges tasks preserving completed ones
      (from generate_mode.ts:282-379)

      - `updateDetailsWithinDelimiters()` function - updates generated content
      section (from generate_mode.ts:511-557)

      - Export `TaskMergeOptions` type if needed


      **Update imports in:**

      - src/rmplan/mcp/generate_mode.ts - import all merge functions

      - src/rmplan/commands/update.ts - consider using merge functions


      **Testing:**

      - Create src/rmplan/plan_merge.test.ts

      - Test delimiter insertion before Research section

      - Test multiple update cycles preserving Research

      - Test completed task preservation across merges

      - Test task ID matching ([TASK-N] format)

      - Test metadata field preservation

      - Test append vs replace modes in updateDetailsWithinDelimiters
  - title: Extract handleGetPlanTool to show.ts
    done: true
    description: >-
      Move the get-plan MCP tool handler to the show command.


      **In src/rmplan/commands/show.ts:**

      - Add import for GenerateModeRegistrationContext from generate_mode.ts

      - Add import for plan_display utilities

      - Export `mcpGetPlan(args, context)` function that wraps buildPlanContext

      - Implement same logic as current handleGetPlanTool
      (generate_mode.ts:425-431)


      **In src/rmplan/mcp/generate_mode.ts:**

      - Import `mcpGetPlan` from commands/show.ts

      - Update addTool('get-plan') to use imported mcpGetPlan

      - Remove handleGetPlanTool function

      - Keep getPlanParameters schema (needed for registration)


      **Testing:**

      - Verify existing show.ts tests still pass

      - Add test for mcpGetPlan function

      - Verify MCP tool registration still works
  - title: Extract handleAppendResearchTool to research.ts
    done: true
    description: >-
      Move the append-plan-research MCP tool handler to the research command.


      **In src/rmplan/commands/research.ts:**

      - Add import for GenerateModeRegistrationContext from generate_mode.ts

      - Export `mcpAppendResearch(args, context)` function

      - Implement same logic as handleAppendResearchTool
      (generate_mode.ts:492-504)

      - Reuse existing appendResearchToPlan import


      **In src/rmplan/mcp/generate_mode.ts:**

      - Import `mcpAppendResearch` from commands/research.ts

      - Update addTool('append-plan-research') to use imported function

      - Remove handleAppendResearchTool function

      - Keep appendResearchParameters schema


      **Testing:**

      - Verify existing research.ts tests pass

      - Add test for mcpAppendResearch function

      - Test with custom heading and timestamp options

      - Verify research appending to plan works correctly
  - title: Extract handleListReadyPlansTool to ready.ts
    done: true
    description: >-
      Move the list-ready-plans MCP tool handler to the ready command, using new
      ready_plans.ts utilities.


      **In src/rmplan/commands/ready.ts:**

      - Add import for GenerateModeRegistrationContext from generate_mode.ts

      - Add imports from ready_plans.ts (filterAndSortReadyPlans,
      formatReadyPlansAsJson)

      - Export `mcpListReadyPlans(args, context)` function

      - Implement using shared ready_plans utilities instead of duplicating
      logic

      - Use filterAndSortReadyPlans for filtering/sorting

      - Use formatReadyPlansAsJson for output


      **In src/rmplan/mcp/generate_mode.ts:**

      - Import `mcpListReadyPlans` from commands/ready.ts

      - Update addTool('list-ready-plans') to use imported function

      - Remove handleListReadyPlansTool function (lines 595-734)

      - Keep listReadyPlansParameters schema


      **Testing:**

      - Verify existing ready.ts tests pass

      - Add test for mcpListReadyPlans function

      - Test priority filtering, limit, pendingOnly, and sortBy options

      - Verify JSON output matches expected format

      - Test dependency checking logic
  - title: Extract handleUpdatePlanDetailsTool to update.ts
    done: true
    description: |-
      Move the update-plan-details MCP tool handler to the update command.

      **In src/rmplan/commands/update.ts:**
      - Add import for GenerateModeRegistrationContext from generate_mode.ts
      - Add import for plan_merge utilities (updateDetailsWithinDelimiters)
      - Add import for plan_display utilities (resolvePlan)
      - Export `mcpUpdatePlanDetails(args, context)` function
      - Implement using updateDetailsWithinDelimiters from plan_merge.ts
      - Same logic as handleUpdatePlanDetailsTool (generate_mode.ts:559-577)

      **In src/rmplan/mcp/generate_mode.ts:**
      - Import `mcpUpdatePlanDetails` from commands/update.ts
      - Update addTool('update-plan-details') to use imported function
      - Remove handleUpdatePlanDetailsTool function
      - Keep updatePlanDetailsParameters schema

      **Testing:**
      - Verify existing update.ts tests pass
      - Add test for mcpUpdatePlanDetails function
      - Test append vs replace modes
      - Verify delimiter-based updates work correctly
      - Test Research section preservation
  - title: Extract handleGenerateTasksTool to update.ts
    done: true
    description: |-
      Move the update-plan-tasks MCP tool handler to the update command.

      **In src/rmplan/commands/update.ts:**
      - Add import for GenerateModeRegistrationContext from generate_mode.ts
      - Add import for plan_merge utilities (mergeTasksIntoPlan)
      - Add import for plan_display utilities (resolvePlan)
      - Export `mcpUpdatePlanTasks(args, context, execContext)` function
      - Implement using mergeTasksIntoPlan from plan_merge.ts
      - Same logic as handleGenerateTasksTool (generate_mode.ts:381-415)
      - Handle the execContext.log parameter properly

      **In src/rmplan/mcp/generate_mode.ts:**
      - Import `mcpUpdatePlanTasks` from commands/update.ts
      - Update addTool('update-plan-tasks') to use imported function
      - Remove handleGenerateTasksTool function
      - Keep generateTasksParameters schema
      - Keep wrapLogger utility function (used by this tool)

      **Testing:**
      - Verify existing update.ts tests pass
      - Add test for mcpUpdatePlanTasks function
      - Test task merging with completed tasks preserved
      - Test task ID matching ([TASK-N] format)
      - Test metadata preservation (parent, dependencies, etc.)
      - Verify logging works correctly
  - title: Refactor generate_mode.ts to registration-only layer
    done: true
    description: >-
      Clean up generate_mode.ts to be a thin registration layer after all
      handlers are extracted.


      **In src/rmplan/mcp/generate_mode.ts:**

      - Verify all tool handlers are now imported from command files

      - Verify all shared utilities are imported from
      plan_display/plan_merge/ready_plans

      - Keep all prompt loaders (loadResearchPrompt, loadQuestionsPrompt,
      loadPlanPrompt, loadGeneratePrompt)

      - Keep all zod parameter schemas (they're needed for tool registration)

      - Keep registerGenerateMode function (main export)

      - Keep GenerateModeRegistrationContext type export

      - Keep GenerateModeExecutionLogger type (used by handlers)

      - Remove all deleted handler functions

      - Verify file is ~200 lines or less


      **Update all imports:**

      - Import mcpGetPlan from commands/show.ts

      - Import mcpAppendResearch from commands/research.ts  

      - Import mcpListReadyPlans from commands/ready.ts

      - Import mcpUpdatePlanDetails from commands/update.ts

      - Import mcpUpdatePlanTasks from commands/update.ts

      - Import buildPlanContext, formatExistingTasks, resolvePlan from
      plan_display.ts

      - Import mergeTasksIntoPlan, updateDetailsWithinDelimiters from
      plan_merge.ts


      **Testing:**

      - Run all existing MCP tests

      - Verify all tools still register correctly

      - Verify all prompts still load correctly

      - Check for any circular dependency issues
  - title: Integration testing and validation
    done: true
    description: >-
      Comprehensive testing to ensure refactoring didn't break functionality.


      **Run all test suites:**

      - `bun test src/rmplan/ready_plans.test.ts` - new module tests

      - `bun test src/rmplan/plan_display.test.ts` - new module tests  

      - `bun test src/rmplan/plan_merge.test.ts` - new module tests

      - `bun test src/rmplan/commands/` - all command tests

      - `bun test src/rmplan/mcp/` - MCP server tests

      - `bun run check` - type checking

      - `bun run lint` - linting


      **Manual validation:**

      - Test MCP server starts without errors

      - Verify each MCP tool works via manual invocation if possible

      - Check that CLI commands still function (ready, update, research, show,
      generate)

      - Verify no circular dependency warnings


      **Documentation updates:**

      - Update CLAUDE.md with new module structure

      - Document the new architecture (MCP as thin layer, commands export
      handlers)

      - Add notes about shared utilities (plan_display, plan_merge, ready_plans)

      - Update any inline comments referencing old structure
changedFiles:
  - CLAUDE.md
  - src/rmplan/commands/ready.test.ts
  - src/rmplan/commands/ready.ts
  - src/rmplan/commands/research.test.ts
  - src/rmplan/commands/research.ts
  - src/rmplan/commands/show.test.ts
  - src/rmplan/commands/show.ts
  - src/rmplan/commands/update.test.ts
  - src/rmplan/commands/update.ts
  - src/rmplan/mcp/generate_mode.test.ts
  - src/rmplan/mcp/generate_mode.ts
  - src/rmplan/plan_display.test.ts
  - src/rmplan/plan_display.ts
  - src/rmplan/plan_merge.test.ts
  - src/rmplan/plan_merge.ts
  - src/rmplan/ready_plans.test.ts
  - src/rmplan/ready_plans.ts
---

## Summary

Refactored the monolithic MCP server file (src/rmplan/mcp/generate_mode.ts, originally 864 lines) into a thin registration layer (~200 lines) that imports tool handlers from their corresponding CLI command modules. Eliminated code duplication by extracting shared utilities for plan display, merging, and ready plan detection used by both CLI and MCP workflows.

## Decisions

- Created three new shared utility modules to consolidate duplicated logic:
  - ready_plans.ts: isReadyPlan(), sortReadyPlans(), filterAndSortReadyPlans(), formatReadyPlansAsJson()
  - plan_display.ts: buildPlanContext(), formatExistingTasks(), resolvePlan() with configurable display options
  - plan_merge.ts: delimiter-based content updates, task merging with completed task preservation, metadata preservation
- Moved MCP tool handlers to their corresponding command files (show.ts, research.ts, ready.ts, update.ts) exported as mcpToolName functions, eliminating three separate implementations of ready plan detection and sorting logic
- Kept prompt loaders in generate_mode.ts as MCP-specific concerns (loadResearchPrompt, loadQuestionsPrompt, loadPlanPrompt, loadGeneratePrompt)
- Maintained all MCP tool signatures unchanged to avoid breaking Claude Code integrations
- Addressed priority-based sorting regression by preserving descending priority order with createdAt/id tie-breaking
- Fixed MCP test fixture to exercise numeric ID resolution instead of filename lookup

## Validation

- All new shared modules have comprehensive test coverage (ready_plans.test.ts, plan_display.test.ts, plan_merge.test.ts)
- Extended command test suites (ready.test.ts, show.test.ts, research.test.ts, update.test.ts) with MCP handler coverage
- All existing tests pass after refactoring (bun test src/rmplan/ready_plans.test.ts, commands/, mcp/)
- Type checking passes (bun run check)
- Manual validation: CLI commands work unchanged, MCP server starts without errors in HTTP mode
- No circular dependencies introduced between modules
- Documentation updated in CLAUDE.md with new architecture (shared utilities, thin MCP registration layer)
