---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Implement rmplan add-task and remove-task commands
goal: ""
id: 132
uuid: 7ebf9d14-805e-4178-83a7-a1e91154de23
generatedBy: agent
status: done
priority: medium
container: false
temp: false
dependencies: []
parent: 128
references:
  "128": f69d418b-aaf1-4c29-88a9-f557baf8f81e
issue: []
pullRequest: []
docs: []
planGeneratedAt: 2025-10-28T23:31:23.749Z
promptsGeneratedAt: 2025-10-28T23:31:23.749Z
createdAt: 2025-10-26T22:41:12.354Z
updatedAt: 2025-10-29T03:49:48.072Z
compactedAt: 2025-10-30T00:00:00.000Z
compactedBy: claude-code
progressNotes:
  - timestamp: 2025-10-29T03:03:00.217Z
    text: Implemented new task_operations utilities providing title search,
      interactive selection, and editor-backed task info prompts for reuse
      across upcoming commands.
    source: "implementer: Create shared task utilities module"
  - timestamp: 2025-10-29T03:04:24.866Z
    text: Added add-task and remove-task command handlers leveraging shared
      utilities, normalized option inputs, and integrated both commands into the
      main rmplan CLI.
    source: "implementer: Implement add/remove task commands"
  - timestamp: 2025-10-29T03:09:59.338Z
    text: Added add-plan-task and remove-plan-task MCP handlers with validation,
      normalized metadata handling, and registered them in generate mode for
      autonomous agent workflows.
    source: "implementer: Implement MCP task management tools"
  - timestamp: 2025-10-29T03:10:04.032Z
    text: Created unit tests covering task utilities, add/remove command handlers,
      and MCP task operations ensuring new features are validated end-to-end.
    source: "implementer: Write unit tests"
  - timestamp: 2025-10-29T03:12:25.897Z
    text: Ran TypeScript checks and the full Bun test suite to validate new task
      management features; all checks passed successfully.
    source: "implementer: Verification"
  - timestamp: 2025-10-29T03:18:41.288Z
    text: Added integration coverage for rmplan add-task and remove-task commands;
      bun run check and targeted integration suite both pass.
    source: "tester: integration tests"
  - timestamp: 2025-10-29T03:33:59.794Z
    text: Reviewed existing add/remove task command handlers, unit tests, and
      current README coverage to confirm gaps for the requested integration
      workflows.
    source: "implementer: Task 11"
  - timestamp: 2025-10-29T03:39:11.125Z
    text: Added end-to-end coverage in
      src/rmplan/commands/task-management.integration.test.ts for CLI add/remove
      flows, diverse MCP tool combinations, and cross-interface round-trips.
    source: "implementer: Task 11"
  - timestamp: 2025-10-29T03:39:15.964Z
    text: Updated README with explicit add-task/remove-task command descriptions,
      workflow examples, and new MCP tool documentation; noted shared utilities
      and integration tests in CLAUDE.md.
    source: "implementer: Task 12"
  - timestamp: 2025-10-29T03:40:54.984Z
    text: Ran bun run check and the full bun test suite; new task-management
      integration specs passed alongside existing suites.
    source: "tester: Task 11"
  - timestamp: 2025-10-29T03:42:51.166Z
    text: Reviewing existing unit and integration suites for add/remove task flows;
      preparing to run regression tests to confirm new coverage.
    source: "tester: Task 11"
  - timestamp: 2025-10-29T03:44:06.879Z
    text: Augmented unit suites with negative-path coverage for add-task title
      validation and remove-task selector enforcement; reran full bun test suite
      to confirm all 2,345 specs pass.
    source: "tester: Task 11"
tasks:
  - title: Create shared task utilities module
    done: true
    description: >-
      Create `src/rmplan/utils/task_operations.ts` with shared utility functions
      for task manipulation:


      - `findTaskByTitle(tasks: Task[], title: string): number` - Find task
      index by partial title match (case-insensitive)

      - `selectTaskInteractive(tasks: Task[]): Promise<number>` - Present
      interactive checkbox to select a task

      - `promptForTaskInfo(options?: Partial<TaskInput>): Promise<TaskInput>` -
      Interactive prompt for task title, description, files, docs


      These utilities will be used by both add-task and remove-task commands to
      ensure consistent behavior.
  - title: Implement add-task command handler
    done: true
    description: >-
      Create `src/rmplan/commands/add-task.ts` with `handleAddTaskCommand()`
      function:


      **Function signature:**

      ```typescript

      export async function handleAddTaskCommand(
        plan: string,
        options: AddTaskOptions,
        command: any
      ): Promise<void>

      ```


      **Options interface:**

      ```typescript

      export interface AddTaskOptions {
        title?: string;
        description?: string;
        editor?: boolean;
        files?: string[];
        docs?: string[];
        interactive?: boolean;
      }

      ```


      **Implementation steps:**

      1. Load effective config from `command.parent.opts()`

      2. Resolve plan using `resolvePlanFile()`

      3. Read plan using `readPlanFile()`

      4. Collect task info:
         - If `--interactive`, use `promptForTaskInfo()`
         - If `--editor`, use `editor()` from @inquirer/prompts for description
         - Otherwise, require `--title` and `--description` flags
         - Collect optional `--files` and `--docs`
      5. Create new task object with required fields (title, description, done:
      false, steps: [])

      6. Push task to `plan.tasks` array

      7. Update `plan.updatedAt` timestamp

      8. Write plan using `writePlanFile()`

      9. Display success message with task title and index


      **Error handling:**

      - Throw error if plan not found

      - Throw error if required fields missing (non-interactive mode)

      - Handle editor cancellation gracefully
  - title: Implement remove-task command handler
    done: true
    description: >-
      Create `src/rmplan/commands/remove-task.ts` with
      `handleRemoveTaskCommand()` function:


      **Function signature:**

      ```typescript

      export async function handleRemoveTaskCommand(
        plan: string,
        options: RemoveTaskOptions,
        command: any
      ): Promise<void>

      ```


      **Options interface:**

      ```typescript

      export interface RemoveTaskOptions {
        title?: string;
        index?: number;
        interactive?: boolean;
        yes?: boolean;
      }

      ```


      **Implementation steps:**

      1. Load effective config from `command.parent.opts()`

      2. Resolve plan using `resolvePlanFile()`

      3. Read plan using `readPlanFile()`

      4. Identify task to remove:
         - If `--title`, use `findTaskByTitle()` - throw if not found
         - If `--index`, validate bounds - throw if out of range
         - If `--interactive`, use `selectTaskInteractive()`
         - Throw error if none provided
      5. Show task details and confirm deletion (unless `--yes` flag)

      6. Remove task using `splice()`

      7. Update `plan.updatedAt` timestamp

      8. Write plan using `writePlanFile()`

      9. Display success message with:
         - Removed task title and former index
         - Warning about index shifts if removed from middle

      **Error handling:**

      - Throw error if plan not found

      - Throw error if task not found (by title or index)

      - Throw error if no selection method provided

      - Handle confirmation cancellation (user selects 'no')
  - title: Register CLI commands in rmplan.ts
    done: true
    description: >-
      Add command registrations to `src/rmplan/rmplan.ts`:


      **add-task command:**

      ```typescript

      program
        .command('add-task <plan>')
        .description('Add a task to an existing plan (file path or plan ID)')
        .option('--title <title>', 'Task title')
        .option('--description <desc>', 'Task description')
        .option('--editor', 'Open editor for description')
        .option('--files <files...>', 'Related files')
        .option('--docs <docs...>', 'Documentation paths')
        .option('--interactive', 'Prompt for all fields interactively')
        .action(async (plan, options, command) => {
          const { handleAddTaskCommand } = await import('./commands/add-task.js');
          await handleAddTaskCommand(plan, options, command).catch(handleCommandError);
        });
      ```


      **remove-task command:**

      ```typescript

      program
        .command('remove-task <plan>')
        .description('Remove a task from a plan. Prefer --title over --index as indices shift after removal.')
        .option('--title <title>', 'Find task by title (partial match) - RECOMMENDED')
        .option('--index <index>', 'Task index (0-based) - use with caution', (val) => parseInt(val, 10))
        .option('--interactive', 'Select task interactively')
        .option('--yes', 'Skip confirmation prompt')
        .action(async (plan, options, command) => {
          const { handleRemoveTaskCommand } = await import('./commands/remove-task.js');
          await handleRemoveTaskCommand(plan, options, command).catch(handleCommandError);
        });
      ```


      Ensure commands are registered in the appropriate location (likely after
      other task-related commands).
  - title: Implement MCP add-plan-task tool
    done: true
    description: >-
      Add MCP tool for adding tasks in `src/rmplan/mcp/generate_mode.ts`:


      **1. Define parameter schema:**

      ```typescript

      export const addTaskParameters = z
        .object({
          plan: z.string().describe('Plan ID or file path'),
          title: z.string().describe('Task title'),
          description: z.string().describe('Task description'),
          files: z.array(z.string()).optional().describe('Related file paths'),
          docs: z.array(z.string()).optional().describe('Documentation paths'),
        })
        .describe('Add a new task to an existing plan');
      ```


      **2. Create handler function (can be in same file or separate command
      module):**

      ```typescript

      export async function mcpAddTask(
        args: z.infer<typeof addTaskParameters>,
        context: GenerateModeRegistrationContext,
        execContext: { log: GenerateModeExecutionLogger }
      ): Promise<string> {
        const { plan, planPath } = await resolvePlan(args.plan, context);
        
        const newTask = {
          title: args.title,
          description: args.description,
          done: false,
          files: args.files || [],
          docs: args.docs || [],
          steps: [],
        };
        
        plan.tasks.push(newTask);
        plan.updatedAt = new Date().toISOString();
        
        await writePlanFile(planPath, plan);
        
        const relativePath = path.relative(context.gitRoot, planPath) || planPath;
        return `Added task "${args.title}" to plan ${plan.id} at index ${plan.tasks.length - 1}`;
      }

      ```


      **3. Register tool in `registerGenerateMode()`:**

      ```typescript

      server.addTool({
        name: 'add-plan-task',
        description: 'Add a new task to an existing plan',
        parameters: addTaskParameters,
        annotations: {
          destructiveHint: true,
        },
        execute: async (args, execContext) => {
          try {
            return await mcpAddTask(args, context, {
              log: wrapLogger(execContext.log, '[add-plan-task] '),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(message);
          }
        },
      });

      ```
  - title: Implement MCP remove-plan-task tool
    done: true
    description: >-
      Add MCP tool for removing tasks in `src/rmplan/mcp/generate_mode.ts`:


      **1. Define parameter schema:**

      ```typescript

      export const removeTaskParameters = z
        .object({
          plan: z.string().describe('Plan ID or file path'),
          taskIndex: z.number().optional().describe('Task index (0-based). Note: indices shift after removal.'),
          taskTitle: z.string().optional().describe('Task title to search for (partial match). Preferred over taskIndex.'),
        })
        .describe('Remove a task from a plan by title (preferred) or index. Note: task indices shift after removal.');
      ```


      **2. Create handler function:**

      ```typescript

      export async function mcpRemoveTask(
        args: z.infer<typeof removeTaskParameters>,
        context: GenerateModeRegistrationContext,
        execContext: { log: GenerateModeExecutionLogger }
      ): Promise<string> {
        const { plan, planPath } = await resolvePlan(args.plan, context);
        
        let taskIndex: number;
        if (args.taskTitle) {
          taskIndex = plan.tasks.findIndex(t => 
            t.title.toLowerCase().includes(args.taskTitle!.toLowerCase())
          );
          if (taskIndex === -1) {
            throw new UserError(`No task found matching: ${args.taskTitle}`);
          }
        } else if (args.taskIndex !== undefined) {
          taskIndex = args.taskIndex;
          if (taskIndex < 0 || taskIndex >= plan.tasks.length) {
            throw new UserError(`Invalid task index: ${args.taskIndex}. Plan has ${plan.tasks.length} tasks.`);
          }
        } else {
          throw new UserError('Must provide either taskIndex or taskTitle');
        }
        
        const removed = plan.tasks.splice(taskIndex, 1)[0];
        plan.updatedAt = new Date().toISOString();
        
        await writePlanFile(planPath, plan);
        
        const relativePath = path.relative(context.gitRoot, planPath) || planPath;
        const shiftWarning = taskIndex < plan.tasks.length 
          ? ` Note: Indices of ${plan.tasks.length - taskIndex} subsequent tasks have shifted.`
          : '';
        return `Removed task "${removed.title}" from plan ${plan.id} (was at index ${taskIndex}).${shiftWarning}`;
      }

      ```


      **3. Register tool in `registerGenerateMode()`:**

      ```typescript

      server.addTool({
        name: 'remove-plan-task',
        description: 'Remove a task from a plan by title or index',
        parameters: removeTaskParameters,
        annotations: {
          destructiveHint: true,
        },
        execute: async (args, execContext) => {
          try {
            return await mcpRemoveTask(args, context, {
              log: wrapLogger(execContext.log, '[remove-plan-task] '),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(message);
          }
        },
      });

      ```
  - title: Write tests for task utilities
    done: true
    description: >-
      Create `src/rmplan/utils/task_operations.test.ts` with comprehensive
      tests:


      **Test cases for `findTaskByTitle`:**

      - Exact title match returns correct index

      - Partial title match (case-insensitive) returns correct index

      - Returns first match when multiple tasks match

      - Returns -1 when no tasks match

      - Empty string matches all tasks (returns 0)


      **Test cases for `selectTaskInteractive`:**

      - Mock checkbox to return selected index

      - Mock checkbox cancellation throws or returns -1

      - Displays task titles with done status indicators

      - Handles empty task list


      **Test cases for `promptForTaskInfo`:**

      - Interactive prompts collect all fields

      - Pre-filled options are used as defaults

      - Editor mode collects description via editor

      - Handles prompt cancellation


      **Test setup:**

      - Use ModuleMocker to mock @inquirer/prompts

      - Create sample task arrays for testing

      - Use real task type definitions from schema
  - title: Write tests for add-task command
    done: true
    description: |-
      Create `src/rmplan/commands/add-task.test.ts` with comprehensive tests:

      **Test cases:**
      1. Add task with --title and --description flags
      2. Add task with --files and --docs options
      3. Add task interactively (mock prompts)
      4. Add task with --editor (mock editor response)
      5. Error when plan not found
      6. Error when required fields missing (non-interactive)
      7. Verify task appended to end of tasks array
      8. Verify updatedAt timestamp updated
      9. Verify task structure matches schema (done: false, steps: [])
      10. Add multiple tasks in sequence

      **Test setup:**
      - Create temp directory with test plan files
      - Mock logging, config, git utilities
      - Mock @inquirer/prompts for interactive tests
      - Use ModuleMocker for all module mocks
      - Clean up temp directory in afterEach

      **Verification:**
      - Read plan file after command execution
      - Verify task exists in tasks array
      - Verify all fields set correctly
      - Verify timestamp updated
  - title: Write tests for remove-task command
    done: true
    description: |-
      Create `src/rmplan/commands/remove-task.test.ts` with comprehensive tests:

      **Test cases:**
      1. Remove task by --title (exact match)
      2. Remove task by --title (partial match)
      3. Remove task by --index
      4. Remove task interactively (mock selection)
      5. Error when task not found by title
      6. Error when invalid index (negative)
      7. Error when invalid index (out of bounds)
      8. Error when no selection method provided
      9. Confirmation prompt works (mock confirm)
      10. --yes flag skips confirmation
      11. User declines confirmation (no changes)
      12. Verify indices shift after removal from middle
      13. Verify removing last task doesn't shift indices
      14. Verify updatedAt timestamp updated

      **Test setup:**
      - Create temp directory with test plan files
      - Create plans with multiple tasks for index shift testing
      - Mock logging, config, git utilities
      - Mock @inquirer/prompts for interactive/confirmation tests
      - Use ModuleMocker for all module mocks
      - Clean up temp directory in afterEach

      **Verification:**
      - Read plan file after command execution
      - Verify correct task removed
      - Verify remaining tasks shifted correctly
      - Verify task count decreased by 1
      - Verify timestamp updated
  - title: Write tests for MCP tools
    done: true
    description: |-
      Add tests to `src/rmplan/mcp/generate_mode.test.ts` for the new MCP tools:

      **Test cases for add-plan-task:**
      1. Add task with all fields (title, description, files, docs)
      2. Add task with minimal fields (title, description only)
      3. Error when plan not found
      4. Verify task appended to tasks array
      5. Verify return message includes task title and index
      6. Verify updatedAt timestamp updated

      **Test cases for remove-plan-task:**
      1. Remove task by taskTitle
      2. Remove task by taskIndex
      3. Error when task not found by title
      4. Error when invalid taskIndex (out of bounds)
      5. Error when neither taskTitle nor taskIndex provided
      6. Verify return message includes shift warning when applicable
      7. Verify task removed from array
      8. Verify updatedAt timestamp updated

      **Test setup:**
      - Create temp directory with test plan files
      - Set up GenerateModeRegistrationContext
      - Use stub logger for execContext
      - Create plans with multiple tasks for comprehensive testing
      - Use clearPlanCache() between tests
      - Clean up temp directory in afterEach

      **Verification:**
      - Call MCP handler functions directly
      - Read plan file after execution
      - Verify plan modifications
      - Verify return messages are descriptive
  - title: Integration testing
    done: true
    description: >-
      Create integration tests that verify end-to-end workflows:


      **Integration test scenarios:**

      1. **Add-then-show workflow:**
         - Add task to plan using add-task command
         - Use `rmplan show` to display plan
         - Verify new task appears in output

      2. **Remove-then-show workflow:**
         - Create plan with 3 tasks
         - Remove middle task using remove-task command
         - Use `rmplan show` to display plan
         - Verify correct task removed and indices shifted

      3. **Round-trip workflow:**
         - Add task to plan
         - Remove same task
         - Verify plan returns to original state

      4. **MCP integration:**
         - Use add-plan-task MCP tool to add task
         - Use remove-plan-task MCP tool to remove task
         - Verify both tools work correctly together

      5. **Mixed CLI and MCP:**
         - Add task via CLI
         - Remove task via MCP tool
         - Verify cross-compatibility

      **Test location:** Add to existing integration test file or create
      `src/rmplan/commands/task-management.integration.test.ts`


      **Verification:**

      - All commands complete successfully

      - Plan files are modified correctly

      - No data corruption or schema violations

      - Timestamps updated appropriately
  - title: Update documentation
    done: true
    description: >-
      Update project documentation to include the new commands:


      **1. Update README.md:**

      - Add `rmplan add-task` to command list with brief description

      - Add `rmplan remove-task` to command list with brief description

      - Include note about preferring title-based removal

      - Include warning about index stability


      **2. Add usage examples:**

      Create section showing common workflows:

      ```bash

      # Add a task

      rmplan add-task 42 --title "Add tests" --description "Add unit tests for
      new feature"


      # Remove a task by title (recommended)

      rmplan remove-task 42 --title "Add tests"


      # Interactive task management

      rmplan add-task 42 --interactive

      rmplan remove-task 42 --interactive

      ```


      **3. Document MCP tools:**

      - Add `add-plan-task` tool to MCP documentation

      - Add `remove-plan-task` tool to MCP documentation

      - Include parameter descriptions

      - Note about index stability in tool descriptions


      **4. Update CLAUDE.md if applicable:**

      - Add any new patterns or conventions established

      - Document the task utilities module

      - Note testing patterns used
changedFiles:
  - CLAUDE.md
  - README.md
  - src/rmplan/commands/add-task.test.ts
  - src/rmplan/commands/add-task.ts
  - src/rmplan/commands/agent/agent.test.ts
  - src/rmplan/commands/agent/agent.ts
  - src/rmplan/commands/agent/agent_batch_mode.test.ts
  - src/rmplan/commands/done.test.ts
  - src/rmplan/commands/remove-task.test.ts
  - src/rmplan/commands/remove-task.ts
  - src/rmplan/commands/renumber.ts
  - src/rmplan/commands/task-management.integration.test.ts
  - src/rmplan/commands/validate.test.ts
  - src/rmplan/commands/validate.ts
  - src/rmplan/mcp/generate_mode.test.ts
  - src/rmplan/mcp/generate_mode.ts
  - src/rmplan/planSchema.ts
  - src/rmplan/plans/prepare_step.ts
  - src/rmplan/process_markdown.ts
  - src/rmplan/rmplan.integration.test.ts
  - src/rmplan/rmplan.ts
  - src/rmplan/utils/references.ts
  - src/rmplan/utils/task_operations.test.ts
  - src/rmplan/utils/task_operations.ts
rmfilter: []
---

## Summary

Successfully implemented dynamic task management for rmplan, enabling both CLI and autonomous agent workflows to add and remove tasks from existing
plans without manual YAML editing. Delivered two CLI commands (`add-task` and `remove-task`) with interactive, editor, and flag-based input modes,
plus corresponding MCP tools (`add-plan-task` and `remove-plan-task`) for agent integration.

## Decisions

- **Task identification strategy**: Chose title-based search (partial, case-insensitive) as the recommended approach for task removal, with index-based
  removal available but discouraged due to index instability. Documented index shift warnings in both CLI output and MCP tool return messages.
- **Index stability trade-off**: Selected simple array `splice()` removal with clear user warnings over stable identifiers, matching existing codebase
  patterns and minimizing implementation complexity. CLI displays shift warnings; documentation emphasizes title-based removal.
- **Shared utilities module**: Created `src/rmplan/utils/task_operations.ts` consolidating `findTaskByTitle`, `selectTaskInteractive`, and
  `promptForTaskInfo` to ensure consistent behavior across CLI commands and enable potential future reuse.
- **Interactive input modes**: Implemented three task input methods for add-task: flag-based (--title/--description), editor mode (--editor), and
  fully interactive (--interactive), with metadata normalization (files/docs) across all modes.
- **Confirmation workflow**: Added confirmation prompts (via @inquirer/prompts) for remove-task with --yes flag to bypass, following established
  patterns in commands like `assignments.ts` cleanup operations.
- **MCP integration architecture**: Followed existing delegation pattern where MCP registration in `generate_mode.ts` acts as thin adapter, wrapping
  errors in UserError for LLM-friendly messages while command modules handle core logic.

## Validation

- Comprehensive test coverage: Unit tests for task utilities (title search, interactive selection), command handlers (add/remove with all input modes),
  and MCP tools; integration suite covering CLI workflows, MCP sequences, and cross-interface compatibility (task-management.integration.test.ts).
- All 2,345+ existing test specs passed after implementation, confirming no regressions to existing plan manipulation workflows.
- Documentation updated: README.md expanded with command descriptions, workflow examples, and MCP tool parameters; CLAUDE.md documents shared utilities
  module and integration test requirements for future task management modifications.

## Research

- Task schema requires `title` and `description` fields; `done` defaults to false, optional `files`/`docs` arrays default to empty
  (src/rmplan/planSchema.ts:25-33) - directly informed task creation logic in add-task and MCP handlers.
- Existing commands use `resolvePlanFile()` → `readPlanFile()` → modify → `writePlanFile()` pattern with automatic `updatedAt` timestamp updates
  (src/rmplan/plans.ts:208-641) - adopted for both add-task and remove-task implementations.
- MCP tools use FastMCP with Zod schemas, delegation pattern where registration wraps errors in UserError, and command modules contain handler logic
  (src/rmplan/mcp/generate_mode.ts) - followed for add-plan-task and remove-plan-task tool registration.
- Interactive features use @inquirer/prompts with `--yes` flag pattern: check flag first, then prompt with `confirm()` if unset
  (src/rmplan/commands/assignments.ts:332-335) - implemented for remove-task confirmation workflow.
- Testing uses real filesystem with temp directories, ModuleMocker for module mocks (Bun's mock.module() unreliable), and clearPlanCache() in
  beforeEach (src/rmplan/commands/*.test.ts) - applied across task_operations, add-task, remove-task, and MCP test suites.

