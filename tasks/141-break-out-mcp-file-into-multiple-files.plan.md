---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: break out MCP file into multiple files
goal: ""
id: 141
uuid: 58b83739-f558-4f60-b80b-b9378fd75d78
generatedBy: agent
status: in_progress
priority: high
temp: false
planGeneratedAt: 2025-10-27T19:36:54.793Z
promptsGeneratedAt: 2025-10-27T19:36:54.793Z
createdAt: 2025-10-27T06:31:21.571Z
updatedAt: 2025-10-27T20:25:38.973Z
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
    steps: []
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
    steps: []
  - title: Create plan_merge.ts shared utility module
    done: false
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
    steps: []
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
    steps: []
  - title: Extract handleAppendResearchTool to research.ts
    done: false
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
    steps: []
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
    steps: []
  - title: Extract handleUpdatePlanDetailsTool to update.ts
    done: false
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
    steps: []
  - title: Extract handleGenerateTasksTool to update.ts
    done: false
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
    steps: []
  - title: Refactor generate_mode.ts to registration-only layer
    done: false
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
    steps: []
  - title: Integration testing and validation
    done: false
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
    steps: []
changedFiles:
  - src/rmplan/commands/ready.test.ts
  - src/rmplan/commands/ready.ts
  - src/rmplan/commands/show.test.ts
  - src/rmplan/commands/show.ts
  - src/rmplan/mcp/generate_mode.test.ts
  - src/rmplan/mcp/generate_mode.ts
  - src/rmplan/plan_display.test.ts
  - src/rmplan/plan_display.ts
  - src/rmplan/ready_plans.test.ts
  - src/rmplan/ready_plans.ts
---

Where possible the tool and prompt implementations should be moved into the relevant file for the corresponding rmplan CLI command.

## Research

### Summary
The MCP server file `src/rmplan/mcp/generate_mode.ts` (864 lines) contains tool and prompt implementations that correspond to several rmplan CLI commands. The goal is to refactor this monolithic file by extracting tool handlers and prompt loaders into their relevant command files, reducing duplication and improving maintainability. The MCP server should become a thin registration layer that imports functionality from command modules.

### Findings

#### Current MCP Server Structure

The `generate_mode.ts` file contains:
- **4 prompt loaders**: `loadResearchPrompt`, `loadQuestionsPrompt`, `loadPlanPrompt`, `loadGeneratePrompt`
- **5 tool handlers**: `handleGenerateTasksTool`, `handleGetPlanTool`, `handleAppendResearchTool`, `handleUpdatePlanDetailsTool`, `handleListReadyPlansTool`
- **3 helper functions**: `formatExistingTasks`, `buildPlanContext`, `resolvePlan`
- **Registration function**: `registerGenerateMode` that wires everything to the FastMCP server

#### Relationship to CLI Commands

**1. Generate Command (src/rmplan/commands/generate.ts)**

The generate command is a CLI orchestrator for plan generation with three operational modes:
- **Claude Mode** (default): Uses Claude Code for planning
- **Direct Mode**: Calls LLM directly with rmfilter output  
- **Clipboard Mode**: Copies to clipboard for manual pasting

Key overlaps with MCP:
- `loadResearchPrompt()` - generates research phase prompt for Claude Code
- `loadQuestionsPrompt()` - generates collaboration prompt
- `loadGeneratePrompt()` - generates task generation prompt
- `buildPlanContext()` - formats plan metadata (lines 45-81 in generate_mode.ts, similar to logic in generate.ts lines 446-479)

The generate command handles input sources (GitHub issues, editors, files) and rmfilter integration that the MCP server doesn't need. However, the prompt generation logic is shared.

**2. Update Command (src/rmplan/commands/update.ts)**

The update command orchestrates plan updates through a structured workflow:
- Loads existing plan
- Converts to Markdown with task IDs
- Gets update description from user
- Runs rmfilter for context
- Processes LLM response to update plan

Key overlaps with MCP:
- `handleUpdatePlanDetailsTool()` - updates plan details within delimiter-bounded sections
- `handleGenerateTasksTool()` - merges tasks while preserving completed ones
- `mergeTasksIntoPlan()` function (lines 282-379 in generate_mode.ts) - task merging logic

Both systems preserve metadata (parent, dependencies, issue URLs) and handle completed task preservation, but through different mechanisms:
- CLI: Markdown conversion with manual workflow
- MCP: Direct task objects with agent workflow

**3. List/Ready Commands (src/rmplan/commands/list.ts and ready.ts)**

The list command provides comprehensive plan inventory, while ready command focuses on executable work.

Key overlaps with MCP:
- `handleListReadyPlansTool()` (lines 595-734) contains **significant duplication**:
  - Ready plan detection logic (duplicated in ready.ts lines 60-93)
  - Sorting logic (duplicated from ready.ts lines 98-180)
  - Priority filtering (simple filter duplicated)
  - JSON output format (similar to ready.ts lines 434-463)

The MCP tool should import these functions from a shared utility module rather than reimplementing them.

**4. Research Command (src/rmplan/commands/research.ts)**

The research command implements interactive research collection workflow:
- Generates research prompts based on plan
- Optionally integrates rmfilter for context
- Prompts user to paste research back
- Appends to plan under `## Research` section

Key overlaps with MCP:
- `handleAppendResearchTool()` (lines 492-504) is a server-side mirror of research.ts core functionality
- Both use `appendResearchToPlan()` from `research_utils.ts`
- Both support custom heading and timestamp control
- Only difference is input source (user paste vs agent output)

The handler could be unified with research.ts since both follow the same pattern: resolve plan → append research → write to file.

**5. Show Command (src/rmplan/commands/show.ts)**

The show command displays detailed plan information with rich terminal formatting.

Key overlaps with MCP:
- `handleGetPlanTool()` uses `buildPlanContext()` to format plan metadata
- `buildPlanContext()` (lines 45-81) provides minimal context for AI
- show.ts provides much more: assignment info, dependencies, progress notes, color formatting

The overlap is appropriate - MCP provides AI-focused context while CLI provides human-focused display. Main consolidation opportunity is in plan resolution logic.

#### Detailed Function Analysis

**Functions that belong in command files:**

| Function | Current Location | Should Move To | Rationale |
|----------|------------------|----------------|-----------|
| `loadResearchPrompt()` | generate_mode.ts:97 | commands/generate.ts | Research prompt generation is part of generate workflow |
| `loadQuestionsPrompt()` | generate_mode.ts:125 | commands/generate.ts | Question generation for planning |
| `loadPlanPrompt()` | generate_mode.ts:150 | commands/show.ts or new plan_context.ts | Plan context display |
| `loadGeneratePrompt()` | generate_mode.ts:172 | commands/generate.ts | Task generation prompt |
| `handleGenerateTasksTool()` | generate_mode.ts:381 | commands/update.ts | Task merging/updating logic |
| `handleGetPlanTool()` | generate_mode.ts:425 | Shared utility or show.ts | Plan context retrieval |
| `handleAppendResearchTool()` | generate_mode.ts:492 | commands/research.ts | Research appending logic |
| `handleUpdatePlanDetailsTool()` | generate_mode.ts:559 | commands/update.ts | Details updating logic |
| `handleListReadyPlansTool()` | generate_mode.ts:595 | commands/ready.ts or new shared module | Ready plan filtering/listing |

**Helper functions that should be extracted:**

| Function | Current Location | Should Move To | Rationale |
|----------|------------------|----------------|-----------|
| `formatExistingTasks()` | generate_mode.ts:22 | New plan_display.ts | Shared formatting utility |
| `buildPlanContext()` | generate_mode.ts:45 | New plan_display.ts | Shared context building |
| `resolvePlan()` | generate_mode.ts:83 | Existing plans.ts | Core plan resolution |
| `mergeDetails()` | generate_mode.ts:244 | New plan_merge.ts | Shared merging logic |
| `mergeTasksIntoPlan()` | generate_mode.ts:282 | New plan_merge.ts | Shared task merging |
| `updateDetailsWithinDelimiters()` | generate_mode.ts:511 | New plan_merge.ts | Delimiter-based updates |
| `findResearchSectionStart()` | generate_mode.ts:233 | research_utils.ts | Research section utilities |

**Code Duplication Issues:**

1. **Ready Plan Logic** - Three implementations exist:
   - `ready.ts` lines 60-93: `isReadyPlan()` function
   - `plans.ts` lines 419-447: `isPlanReady()` (only checks pending, different semantics)
   - `generate_mode.ts` lines 606-630: Inline in MCP tool
   
   **Action needed**: Extract to shared `src/rmplan/ready_plans.ts` module

2. **Sorting Logic** - Duplicated completely:
   - `ready.ts` lines 98-180: `sortPlans()` function
   - `generate_mode.ts` lines 638-703: Inline duplicate
   
   **Action needed**: Use shared function from ready_plans.ts

3. **Plan Context Building** - Similar logic in multiple places:
   - `generate_mode.ts` lines 45-81: `buildPlanContext()`
   - `generate.ts` lines 446-479: Similar plan loading logic
   - `show.ts`: More detailed display logic
   
   **Action needed**: Create tiered display utilities (minimal, detailed, full)

#### Subagent Detailed Reports

**Generate Command Analysis:**

The `generate.ts` command handler orchestrates multi-step plan generation. It handles:
- Plan input from multiple sources (--issue, --plan-editor, --use-yaml, --next-ready, --latest)
- Stub plan creation with plan text in details field
- Context gathering from configured documents
- Three operational modes: Claude, Direct, or Clipboard
- Rmfilter integration in traditional mode
- Post-generation markdown-to-YAML extraction
- Plan merging for updates

The command uses four different prompts from prompt.ts: `planPrompt()`, `simplePlanPrompt()`, `generateClaudeCodePlanningPrompt()`, `generateClaudeCodeGenerationPrompt()`. When Claude mode is active, it calls `invokeClaudeCodeForGeneration()` which wraps the Claude Code orchestrator.

Research capture is handled by capturing `researchOutput` from Claude Code (line 710) and persisting it with delimiter markers. The MCP server provides `append-plan-research` tool for Claude to save findings explicitly.

**Update Command Analysis:**

The `handleUpdateCommand` manages complete plan update workflow. It:
- Loads existing plan
- Converts plan to Markdown with task IDs  
- Gets update description from args or editor
- Generates update prompt instructing LLM to preserve completed tasks
- Runs rmfilter for code context
- Processes LLM response via `extractMarkdownToYaml()`
- Preserves all metadata during update

The MCP `update-plan-tasks` tool is a direct peer doing at scale what update does manually. The `update-plan-details` tool is complementary, handling just the details field with delimiter-bounded content management. Both systems preserve metadata through explicit field copying or spread operators.

**List/Ready Commands Analysis:**

The list command provides comprehensive inventory showing all plans with detailed metadata in rich table format. The ready command focuses on finding executable work - only shows pending/in_progress plans with all dependencies done.

The MCP `list-ready-plans` tool is a JSON API for the same ready plan logic. There's significant duplication:
- Ready plan detection (3 implementations)
- Sorting by priority/id/title/created/updated (duplicated completely)
- Priority filtering (simple filter duplicated)
- JSON output format (similar structures)

Recommended: Extract shared `ReadyPlanLogic` utility module with `isReadyPlan()`, `sortReadyPlans()`, `filterAndSortReadyPlans()`, `formatReadyPlansAsJson()` functions.

**Research Command Analysis:**

The research command implements interactive research collection:
- Generates context-aware prompts (basic, tutorial with --tutorial, PRD with --prd)
- Optional rmfilter integration with --rmfilter flag
- User interaction loop (copy prompt, wait for paste)
- Automatic append to plan under `## Research` section with timestamps

The command delegates to `appendResearchToPlan()` from research_utils.ts. Features include automatic section creation, no duplication detection, timestamp management, optional focus labeling, and smart insertion preserving existing research.

The MCP `append-plan-research` tool (lines 492-504) is functionally identical - both use same utility, same parameters (heading, timestamp), same workflow (resolve → append → write). Only difference is input source.

**Show Command Analysis:**

The show command displays detailed plan information. It has two modes:
- **Short mode** (--short or watch): Concise summary with latest progress notes, task list
- **Full mode** (default): Complete metadata, workspace, parents, dependencies, description, notes, tasks with steps

Features include rich terminal formatting with colors/icons, assignment tracking integration, dependency visualization, progress monitoring, and watch mode with 5-second refresh loop.

The MCP `get-plan` tool uses `buildPlanContext()` providing minimal context for AI (metadata, goal, tasks summary, details). The show command goes much further with assignment info, dependency resolution, progress notes, color formatting. The overlap is appropriate - they serve different purposes (AI context vs human display).

#### Existing Shared Utilities

These utilities already exist and should be leveraged:
- `src/rmplan/plans.ts`: Core plan I/O operations
- `src/rmplan/research_utils.ts`: Research section handling
- `src/rmplan/prompt.ts`: Prompt generation functions
- `src/rmplan/path_resolver.ts`: Plan file path resolution
- `src/rmplan/configLoader.ts`: Configuration loading
- `src/rmplan/process_markdown.ts`: Markdown-to-YAML conversion

#### Delimiter System for Generated Content

A sophisticated feature in MCP is delimiter-based content management:
```typescript
const GENERATED_START_DELIMITER = '<!-- rmplan-generated-start -->
## Expected Behavior/Outcome

After refactoring, the MCP server file (`src/rmplan/mcp/generate_mode.ts`) will be a thin registration layer that imports functionality from command modules and shared utilities. Tool handlers will live in their corresponding command files, while shared logic will be extracted to focused utility modules.

**Key outcomes:**
- MCP server reduced from 864 lines to ~200 lines (registration only)
- Tool handlers co-located with their corresponding CLI commands
- Shared utilities (display, merge, ready plan logic) extracted to dedicated modules
- No duplication of ready plan detection, sorting, or merging logic
- Prompt loaders remain in MCP file (MCP-specific concern)
- All existing MCP tool signatures remain unchanged (no breaking changes)

## Key Findings

### Product & User Story

The rmplan MCP server provides tools for Claude Code agents to interact with plans during code generation sessions. Currently, the implementation in `generate_mode.ts` duplicates logic from CLI commands and contains functionality that logically belongs in command modules. This refactoring improves maintainability without changing user-facing behavior.

### Design & UX Approach

**Architecture after refactoring:**

```
src/rmplan/
├── mcp/
│   ├── server.ts (unchanged - entry point)
│   └── generate_mode.ts (reduced to ~200 lines)
│       ├── Prompt loaders (kept here - MCP-specific)
│       ├── Tool registration (registerGenerateMode)
│       └── Imports handlers from commands
│
├── commands/
│   ├── generate.ts (gains shared context functions)
│   ├── update.ts (gains update/merge handlers)
│   ├── research.ts (gains append research handler)
│   ├── ready.ts (gains list ready handler)
│   └── show.ts (gains get plan handler)
│
└── Shared utilities (NEW):
    ├── plan_display.ts (buildPlanContext, formatExistingTasks)
    ├── plan_merge.ts (mergeTasksIntoPlan, updateDetailsWithinDelimiters)
    └── ready_plans.ts (isReadyPlan, sortReadyPlans, filterAndSort)
```

**Design principles:**
1. **Thin registration layer**: MCP server only registers tools/prompts
2. **Command ownership**: Each command exports its tool handlers
3. **Shared utilities**: Common logic extracted once, imported everywhere
4. **No breaking changes**: MCP tool signatures stay identical
5. **MCP-specific stays in MCP**: Prompt loaders remain in generate_mode.ts

### Technical Plan & Risks

**Implementation phases:**

**Phase 1: Create shared utility modules**
- Create `src/rmplan/plan_display.ts` with buildPlanContext, formatExistingTasks
- Create `src/rmplan/plan_merge.ts` with merge functions and delimiter logic
- Create `src/rmplan/ready_plans.ts` with ready plan detection and sorting
- Add comprehensive tests for each new module
- Update existing code to import from new modules (no behavior changes)

**Phase 2: Extract tool handlers to commands**
- Move `handleAppendResearchTool` to research.ts, export as `mcpAppendResearch`
- Move `handleGetPlanTool` to show.ts, export as `mcpGetPlan`
- Move `handleUpdatePlanDetailsTool` to update.ts, export as `mcpUpdatePlanDetails`
- Move `handleGenerateTasksTool` to update.ts, export as `mcpUpdatePlanTasks`
- Move `handleListReadyPlansTool` to ready.ts, export as `mcpListReadyPlans`
- Update generate_mode.ts to import and register these handlers

**Phase 3: Update MCP registration**
- Refactor `registerGenerateMode` to import handlers from commands
- Verify all tool parameters (zod schemas) moved with handlers
- Keep prompt loaders in generate_mode.ts as decided
- Update imports and types

**Phase 4: Testing and validation**
- Run all existing tests to ensure no regressions
- Add integration tests for MCP tools post-refactor
- Test Claude Code integration manually if possible
- Verify no circular dependencies introduced

**Risks:**
1. **Circular dependencies**: Commands importing from MCP, MCP importing from commands
   - Mitigation: Commands export pure functions, no imports from MCP
2. **Breaking MCP clients**: Changed import paths or signatures
   - Mitigation: Keep all MCP tool signatures identical
3. **Test coverage gaps**: Extracted code loses test coverage
   - Mitigation: Write tests for shared modules first, then extract
4. **Type inference issues**: Moving zod schemas might break type inference
   - Mitigation: Keep schema definitions adjacent to handlers

### Pragmatic Effort Estimate

**Complexity: Medium**
- ~4-6 hours for experienced developer
- Low risk (mostly code movement, no logic changes)
- High test coverage exists to catch regressions

**Breakdown:**
- Phase 1 (shared modules): 2 hours (includes tests)
- Phase 2 (extract handlers): 1.5 hours
- Phase 3 (update registration): 0.5 hours  
- Phase 4 (testing): 1 hour
- Buffer for issues: 1 hour

## Acceptance Criteria

- [ ] Functional: All MCP tools continue to work identically after refactoring
- [ ] Functional: CLI commands continue to work without changes
- [ ] Code Quality: No duplication of ready plan detection logic
- [ ] Code Quality: No duplication of sorting logic
- [ ] Code Quality: No duplication of merge logic
- [ ] Technical: MCP server file reduced to ~200 lines (registration only)
- [ ] Technical: Tool handlers live in their corresponding command files
- [ ] Technical: Shared utilities extracted to focused modules (plan_display, plan_merge, ready_plans)
- [ ] Technical: Prompt loaders remain in generate_mode.ts
- [ ] Technical: No circular dependencies between modules
- [ ] Testing: All existing tests pass
- [ ] Testing: New shared modules have test coverage
- [ ] Documentation: CLAUDE.md updated with new module structure

## Dependencies & Constraints

**Dependencies:**
- None - self-contained refactoring

**Technical Constraints:**
- FastMCP server registration API must remain stable
- MCP tool parameter schemas (zod) cannot change
- Tool return types must stay compatible
- Prompt loader signatures must stay compatible
- Cannot break existing Claude Code integrations

## Implementation Notes

### Recommended Approach

**Step-by-step execution:**

1. **Start with ready_plans.ts** (highest duplication):
   - Extract `isReadyPlan()` from ready.ts
   - Extract sorting logic from ready.ts
   - Add filtering and JSON formatting utilities
   - Write comprehensive tests
   - Update ready.ts to use new module
   - Update generate_mode.ts to use new module

2. **Create plan_display.ts**:
   - Move `buildPlanContext()` from generate_mode.ts
   - Move `formatExistingTasks()` from generate_mode.ts
   - Consider adding display option tiers (minimal/detailed/full)
   - Write tests
   - Update all importers

3. **Create plan_merge.ts**:
   - Move delimiter constants
   - Move `findResearchSectionStart()` 
   - Move `mergeDetails()`
   - Move `mergeTasksIntoPlan()`
   - Move `updateDetailsWithinDelimiters()`
   - Write tests covering edge cases (delimiter preservation, metadata)
   - Update generate_mode.ts and update.ts

4. **Extract tool handlers one by one**:
   - Start with simplest: `handleGetPlanTool` → show.ts
   - Then: `handleAppendResearchTool` → research.ts
   - Then: `handleListReadyPlansTool` → ready.ts (uses new ready_plans.ts)
   - Then: `handleUpdatePlanDetailsTool` → update.ts (uses plan_merge.ts)
   - Finally: `handleGenerateTasksTool` → update.ts (uses plan_merge.ts)
   - Move zod schemas with each handler
   - Export as `mcpToolName` functions

5. **Update generate_mode.ts**:
   - Import all handlers from commands
   - Update `registerGenerateMode` to use imported handlers
   - Keep prompt loaders (loadResearchPrompt, loadQuestionsPrompt, etc.)
   - Verify reduced to ~200 lines

### Potential Gotchas

1. **Zod schema exports**: When moving schemas with handlers, ensure proper export/import
2. **Type inference**: TypeScript might need help with inferred types from zod schemas
3. **GenerateModeRegistrationContext**: This type is MCP-specific but handlers need it
   - Solution: Export from generate_mode.ts, import in commands
4. **resolvePlan helper**: Currently in generate_mode.ts, many handlers use it
   - Solution: Move to plan_display.ts or keep in generate_mode.ts and import
5. **Delimiter constants**: Used in multiple places
   - Solution: Export from plan_merge.ts as named constants
6. **Test data paths**: Moving code might break test fixture paths
   - Solution: Use path.join(__dirname, ...) for robustness

### Files to Create

1. `src/rmplan/plan_display.ts` - Plan context and formatting utilities
2. `src/rmplan/plan_display.test.ts` - Tests for display utilities
3. `src/rmplan/plan_merge.ts` - Plan merging and delimiter logic
4. `src/rmplan/plan_merge.test.ts` - Tests for merge utilities  
5. `src/rmplan/ready_plans.ts` - Ready plan detection and filtering
6. `src/rmplan/ready_plans.test.ts` - Tests for ready plan utilities

### Files to Modify

1. `src/rmplan/mcp/generate_mode.ts` - Reduce to registration layer
2. `src/rmplan/commands/generate.ts` - Import shared display utilities
3. `src/rmplan/commands/update.ts` - Export MCP handlers, use plan_merge
4. `src/rmplan/commands/research.ts` - Export MCP handler
5. `src/rmplan/commands/ready.ts` - Export MCP handler, use ready_plans
6. `src/rmplan/commands/show.ts` - Export MCP handler, use plan_display
<!-- rmplan-generated-end -->';
```

This allows:
- Generated content to be replaced while preserving manually-added sections
- Research sections to survive regeneration
- Multiple updates without duplicating manual work

The CLI update command uses similar logic through `extractMarkdownToYaml()` but less explicitly.

### Risks & Constraints

**Architectural Hazards:**
1. **Circular dependencies**: Moving tool handlers to command files that might import from MCP server
2. **Breaking MCP clients**: Changing tool signatures or behavior could break Claude Code integrations
3. **Test coverage gaps**: Need to ensure all extracted code maintains test coverage
4. **Import cycles**: Commands importing from each other could create dependency cycles

**Edge Cases:**
1. **Assignment tracking**: Some MCP tools don't handle workspace/user filtering (by design for API)
2. **Delimiter preservation**: Need to ensure delimiter logic is preserved when extracting merge functions
3. **Metadata fields**: Must maintain complete list of preserved fields when extracting merge logic
4. **Timestamp handling**: Research insertion timestamps need careful handling during extraction

**Prerequisites:**
1. Create shared utility modules before moving code (plan_display.ts, plan_merge.ts, ready_plans.ts)
2. Ensure comprehensive test coverage of current MCP tool behavior
3. Add integration tests that verify MCP tools work after refactoring
4. Document the new architecture and import patterns

**Technical Constraints:**
1. FastMCP server registration API must remain stable
2. MCP tool signatures (parameters, return types) cannot change
3. Prompt loader signatures must stay compatible
4. File paths and module structure changes need coordinated updates

### Follow-up Questions

**Q1: Should we create a new shared module structure, or extend existing modules?**

Options:
- **A**: Create new modules (plan_display.ts, plan_merge.ts, ready_plans.ts) for clarity
- **B**: Extend existing plans.ts and research_utils.ts modules
- **C**: Create a new src/rmplan/shared/ directory for all shared utilities

Which approach aligns better with the existing codebase patterns?

**Q2: How should we handle the prompt loaders?**

The prompt loaders (`loadResearchPrompt`, `loadQuestionsPrompt`, etc.) are currently in generate_mode.ts but:
- They're only used by the MCP server (not CLI)
- They reference command-specific logic (generate workflow)
- Moving them to command files would require commands to export MCP-specific functions

Options:
- **A**: Keep prompt loaders in MCP file, move only tool handlers to commands
- **B**: Move prompt loaders to command files as exported functions
- **C**: Create a new src/rmplan/mcp/prompts/ directory for prompt loaders

Which structure would be most maintainable?

**Q3: What's the priority order for extraction?**

Given the different levels of coupling and duplication:
- **High priority**: Ready plan logic (3x duplication, clear benefit)
- **Medium priority**: Research append handler (simple, clear mapping)
- **Lower priority**: Plan context building (works fine, cosmetic improvement)

Should we tackle this incrementally or as one large refactor?

Implemented Task 1 (Create ready_plans.ts shared utility module) and Task 6 (Extract handleListReadyPlansTool to ready.ts). Added new module src/rmplan/ready_plans.ts exposing isReadyPlan, sortReadyPlans, filterAndSortReadyPlans, and formatReadyPlansAsJson with shared priority mapping and git-root aware filename handling. Created src/rmplan/ready_plans.test.ts to cover readiness detection (including numeric-string dependencies), sorting, limiting, and JSON formatting. Updated commands/ready.ts to consume the shared helpers, replace inline readiness/sort logic, and reuse READY_PLAN_SORT_FIELDS while keeping assignment display features intact; the CLI now treats empty-task plans as not ready, so ready.test.ts fixtures were refreshed to ensure each plan under test has at least one task and to assert the new exclusion explicitly. Refactored MCP list-ready-plans handler in mcp/generate_mode.ts to delegate to filterAndSortReadyPlans/formatReadyPlansAsJson, removing the duplicated filtering and sorting logic. Ran bun test on the new module and ready command suites plus bun run check; bun run lint still fails globally because of unrelated pre-existing violations, but targeted eslint on the touched files passes. Formatted touched files with prettier to match project style.

Restored original tie-breaking behavior in the shared ready plan sorter to keep equal-priority plans ordered by creation timestamp while preserving descending priority ordering. Updated sortReadyPlans priority branch in src/rmplan/ready_plans.ts to compare priority in descending order without negating tie-breakers, then fall back to createdAt and id, retaining compatibility with CLI consumers from Task 1 - Create ready_plans.ts shared utility module and Task 6 - Extract handleListReadyPlansTool to ready.ts. Added regression coverage in src/rmplan/ready_plans.test.ts exercising equal-priority plans to confirm the oldest plan surfaces first, ensuring downstream MCP list-ready-plans output remains stable. Verified the fix with bun test runs for ready_plans.test.ts, commands/ready.test.ts, mcp/generate_mode.test.ts, and bun run check so future maintainers know the expected validation suite.

Implemented shared plan_display.ts module (Task 2) to centralize plan context helpers. The file now exports PlanDisplayContext/PlanDisplayOptions plus formatExistingTasks, buildPlanContext, and resolvePlan; buildPlanContext gained section toggles so callers can trim content. Added plan_display.test.ts to cover empty vs populated task summaries, option flags, and resolving plans from real files, and updated generate_mode.ts to import the new helpers instead of embedding them.

Task 4 & Task 9 build on Task 2’s utilities: show.ts now imports plan_display helpers and exposes mcpGetPlan so MCP tools reuse the CLI formatter, and show.test.ts got dedicated coverage that exercises real plan files. generate_mode.ts registers the get-plan tool via that new export while keeping the existing zod schema, and generate_mode.test.ts now calls mcpGetPlan to validate end-to-end output. Verified with bun test src/rmplan/plan_display.test.ts, bun test src/rmplan/commands/show.test.ts, bun test src/rmplan/mcp/generate_mode.test.ts, and bun run check.

Implemented Task 3 - Create plan_merge.ts shared utility module, Task 7 - Extract handleUpdatePlanDetailsTool to update.ts, and Task 8 - Extract handleGenerateTasksTool to update.ts. Added src/rmplan/plan_merge.ts exporting delimiter constants, detail merging helpers, and mergeTasksIntoPlan while keeping metadata and completed tasks intact, plus an accompanying plan_merge.test.ts covering research placement, multi-update flows, validation errors, and metadata preservation. Refactored src/rmplan/commands/update.ts to host the MCP tool handlers, reusing resolvePlan, the new plan_merge helpers, and shared logger typing for mcpUpdatePlanDetails and mcpUpdatePlanTasks; extended update.test.ts with filesystem-backed tests that exercise both handlers end to end. Finally connected src/rmplan/mcp/generate_mode.ts to the extracted handlers, wrapped execution with UserError translation, and updated generate_mode.test.ts to call mcpUpdatePlanTasks via the shared zod schemas. Tests exercised: bun test src/rmplan/plan_merge.test.ts src/rmplan/commands/update.test.ts src/rmplan/mcp/generate_mode.test.ts and bun run check.
