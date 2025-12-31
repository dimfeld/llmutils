---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: replace MCP tools with CLI commands
goal: ""
id: 148
uuid: fea18633-aa57-4072-bb94-dae8ee0654dd
status: done
priority: medium
createdAt: 2025-12-29T01:16:02.088Z
updatedAt: 2025-12-30T20:10:13.829Z
tasks:
  - title: Create src/rmplan/tools/ directory and files
    done: true
    description: |-
      - Move Zod schemas from generate_mode.ts to tools/schemas.ts
      - Create tools/context.ts with ToolContext and ToolResult interfaces
      - Create individual tool files, extracting logic from generate_mode.ts:
        - get_plan.ts
        - create_plan.ts
        - update_plan_tasks.ts
        - update_plan_details.ts
        - manage_plan_task.ts
        - list_ready_plans.ts
      - Create index.ts to re-export all
  - title: Update generate_mode.ts to use shared tools
    done: true
    description: |-
      - Import from ../tools/index.js
      - Replace inline mcp* functions with calls to tool functions
      - Keep MCP-specific wrapper logic (logging, error handling)
      - Use toMcpResult() helper to extract text from ToolResult
  - title: Add tools command to rmplan.ts
    done: true
    description: >-
      - Create tools command group with subcommands

      - Add subcommands for each tool: get-plan, create-plan, update-plan-tasks,
      update-plan-details, manage-plan-task, list-ready-plans

      - Each subcommand should have --json option for structured output

      - Each subcommand calls handleToolCommand()
  - title: Create commands/tools.ts
    done: true
    description: |-
      - Implement readJsonFromStdin() function with TTY detection
      - Implement formatOutput() and formatError() for both text and JSON modes
      - Create toolHandlers mapping tool names to schemas and functions
      - Implement handleToolCommand() that orchestrates the flow
  - title: Add --no-tools option to MCP server
    done: true
    description: |-
      - Add noTools option to StartMcpServerOptions in server.ts
      - Update registerGenerateMode() signature to accept RegisterOptions
      - Conditionally register tools based on registerTools option
      - Update CLI command registration in rmplan.ts
  - title: Write tests
    done: true
    description: |-
      - Unit tests for each tool function in src/rmplan/tools/
      - Integration tests comparing CLI and MCP outputs
      - Tests for error handling (invalid JSON, missing fields, etc.)
      - Follow existing patterns in task-management.integration.test.ts
  - title: Update documentation
    done: true
    description: >-
      - Update claude-plugin/skills/rmplan-usage/SKILL.md with CLI tool section

      - Update claude-plugin/skills/rmplan-usage/references/mcp-tools.md to show
      CLI alternatives

      - Consider creating cli-tools.md dedicated reference
  - title: Run full test suite and manual verification
    done: true
    description: |-
      - Run bun test to verify all tests pass
      - Manual testing of CLI tools with various inputs
      - Verify MCP server --no-tools mode works correctly
      - Compare CLI and MCP outputs for consistency
changedFiles:
  - README.md
  - claude-plugin/skills/rmplan-usage/SKILL.md
  - claude-plugin/skills/rmplan-usage/references/cli-commands.md
  - claude-plugin/skills/rmplan-usage/references/mcp-tools.md
  - src/rmplan/commands/ready.ts
  - src/rmplan/commands/show.ts
  - src/rmplan/commands/tools.test.ts
  - src/rmplan/commands/tools.ts
  - src/rmplan/mcp/generate_mode.test.ts
  - src/rmplan/mcp/generate_mode.ts
  - src/rmplan/mcp/server.ts
  - src/rmplan/plans.ts
  - src/rmplan/rmplan.ts
  - src/rmplan/tools/context.ts
  - src/rmplan/tools/create_plan.ts
  - src/rmplan/tools/get_plan.ts
  - src/rmplan/tools/index.ts
  - src/rmplan/tools/list_ready_plans.ts
  - src/rmplan/tools/manage_plan_task.ts
  - src/rmplan/tools/schemas.ts
  - src/rmplan/tools/update_plan_details.ts
  - src/rmplan/tools/update_plan_tasks.ts
tags: []
---

We want to make it possible to run an agent without the MCP tools, and have it use the CLI instead based on the info in
the rmplan-usage skill. 

The main thing we need to figure out here is how to make this work in a way that is compatible with passing a large
amount of data. I suggest a new command `tools` which has a subcommand for each MCP tool. 

Each of these subcommands can read JSON from stdin and reply with a message to stdout. The MAP function and the
subcommand should share the same schema and functionality. So for each tool we end up with:

- A shared function that does the work and returns a message
- A CLI subcommand that reads JSON from stdin, calls the shared function, and writes a message to stdout
- The MCP tool is updated so that most of its functionality is handled by the shared function.


Finally:
- Add a CLI option to the MCP command that runs it without tools, only prompts and resources.
- Update the relevant documentation in claude-plugin/skills to reflect the new CLI commands and no longer reference MCP
tools.

## Implementation Guide

### Overview

This feature enables agents to use rmplan functionality without requiring MCP server connectivity. Instead of MCP tools, agents will use CLI subcommands under `rmplan tools <tool-name>` that accept JSON input via stdin and return JSON/text output to stdout. This maintains feature parity while supporting environments where MCP servers cannot run.

### Expected Behavior/Outcome

**New User-Facing Behavior:**
- A new `rmplan tools` command group with subcommands mirroring each MCP tool
- Each subcommand reads JSON from stdin (matching the MCP tool's parameter schema)
- Each subcommand writes its result to stdout (matching MCP tool return format)
- The MCP server gains a `--no-tools` flag to run prompts/resources only
- Documentation updated to show CLI alternatives to MCP tools

**States:**
- Normal: CLI tools work independently of MCP server
- MCP-only mode: Server runs with `--no-tools`, provides only prompts and resources
- Hybrid: Both CLI tools and MCP server can be used together (they share the same underlying functions)

### Key Findings

#### Product & User Story

**Primary Users:** Agents running in environments without MCP server support (e.g., API-based agents, custom orchestration systems, or environments where WebSocket/stdio MCP transport is problematic).

**User Story:** "As an agent, I want to manage rmplan plans using CLI commands so that I can create, update, and query plans without requiring an MCP server connection."

#### Design & UX Approach

**CLI Command Structure:**
```bash
rmplan tools <tool-name> [options]
# JSON input from stdin
# Result written to stdout

# Example usage:
echo '{"plan": "123"}' | rmplan tools get-plan
echo '{"title": "New Plan", "priority": "high"}' | rmplan tools create-plan

# JSON output option for scripting:
echo '{"plan": "123"}' | rmplan tools get-plan --json
echo '{}' | rmplan tools list-ready-plans --json
```

**Output Modes:**
- Default: Match MCP tool output format (text for most tools)
- `--json` flag: Return structured JSON for machine parsing

JSON output structure:
```json
{
  "success": true,
  "result": { ... },  // Tool-specific data
  "message": "..."    // Human-readable summary (optional)
}
```

Error JSON structure:
```json
{
  "success": false,
  "error": "Error message",
  "code": "VALIDATION_ERROR"  // Optional error code
}
```

**Tool Subcommands (mirroring MCP tools):**
1. `get-plan` - Retrieve plan details
2. `create-plan` - Create new plan file
3. `update-plan-tasks` - Update plan with generated tasks
4. `update-plan-details` - Update generated section content
5. `manage-plan-task` - Add/update/remove individual tasks
6. `list-ready-plans` - List ready plans

**MCP Server Flag:**
```bash
rmplan mcp-server --no-tools  # Prompts and resources only
```

#### Technical Plan & Risks

**Architecture Overview:**

```
┌──────────────────────────────────────────────────────────────┐
│                    Shared Tool Functions                      │
│  src/rmplan/tools/                                            │
│  ├── get_plan.ts         (getPlanTool)                       │
│  ├── create_plan.ts      (createPlanTool)                    │
│  ├── update_plan_tasks.ts (updatePlanTasksTool)              │
│  ├── update_plan_details.ts (updatePlanDetailsTool)          │
│  ├── manage_plan_task.ts  (managePlanTaskTool)               │
│  ├── list_ready_plans.ts  (listReadyPlansTool)               │
│  ├── schemas.ts          (Zod schemas, exported)             │
│  └── index.ts            (re-exports all)                     │
└──────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
   ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
   │   CLI Commands   │ │   MCP Tools     │ │   Integration   │
   │   rmplan tools   │ │   generate_mode │ │   Tests         │
   │   stdin → stdout │ │   server.addTool│ │   Both paths    │
   └─────────────────┘ └─────────────────┘ └─────────────────┘
```

**Key Files Affected:**

1. **New files to create:**
   - `src/rmplan/tools/` directory with shared implementations
   - `src/rmplan/commands/tools.ts` - CLI command registration
   - `src/rmplan/tools/*.ts` - One file per tool function

2. **Files to modify:**
   - `src/rmplan/rmplan.ts` - Add `tools` command group
   - `src/rmplan/mcp/server.ts` - Add `--no-tools` option
   - `src/rmplan/mcp/generate_mode.ts` - Refactor to use shared functions
   - `claude-plugin/skills/rmplan-usage/SKILL.md` - Update docs
   - `claude-plugin/skills/rmplan-usage/references/mcp-tools.md` - Add CLI alternatives

3. **Existing shared utilities (no changes needed):**
   - `src/rmplan/plan_display.ts` - `resolvePlan()`, `buildPlanContext()`
   - `src/rmplan/ready_plans.ts` - `filterAndSortReadyPlans()`, `formatReadyPlansAsJson()`
   - `src/rmplan/plan_merge.ts` - `mergeTasksIntoPlan()`, `updateDetailsWithinDelimiters()`
   - `src/rmplan/plans.ts` - `readPlanFile()`, `writePlanFile()`

**Risks & Mitigations:**

1. **Risk:** Breaking existing MCP tool behavior during refactoring
   - **Mitigation:** Use existing `task-management.integration.test.ts` pattern to test both CLI and MCP paths

2. **Risk:** Schema drift between CLI and MCP
   - **Mitigation:** Single source of truth for Zod schemas in `src/rmplan/tools/schemas.ts`

3. **Risk:** Large JSON input could be problematic
   - **Mitigation:** stdin reads handle large buffers; this is tested with existing `--format json` commands

4. **Risk:** Error message format differences between CLI and MCP
   - **Mitigation:** Shared error handling in tool functions; consistent JSON error format

#### Pragmatic Effort Estimate

- **Shared tool functions refactor:** 4-6 files, moderate complexity
- **CLI command wrapper:** 1 file with routing, straightforward
- **MCP server --no-tools:** Minor change to existing code
- **Documentation updates:** 2-3 files
- **Testing:** Integration tests for both paths

### Acceptance Criteria

- [ ] **Functional:** `echo '{"plan": "123"}' | rmplan tools get-plan` returns plan details as text
- [ ] **Functional:** All 6 MCP tools have corresponding CLI subcommands under `rmplan tools`
- [ ] **Functional:** CLI tools use same Zod schemas as MCP tools for input validation
- [ ] **Functional:** CLI tools support `--json` flag for structured JSON output
- [ ] **Functional:** JSON output includes `success`, `result`, and optional `message` fields
- [ ] **Functional:** Error JSON output includes `success: false`, `error`, and optional `code` fields
- [ ] **Functional:** `rmplan mcp-server --no-tools` starts server with prompts/resources only
- [ ] **Technical:** Shared tool functions are in `src/rmplan/tools/` directory
- [ ] **Technical:** MCP tools call shared functions (no duplicated logic)
- [ ] **Technical:** CLI tools call same shared functions as MCP tools
- [ ] **Technical:** Invalid JSON input produces clear error messages
- [ ] **Documentation:** `claude-plugin/skills/rmplan-usage/SKILL.md` documents CLI alternatives
- [ ] **Documentation:** `claude-plugin/skills/rmplan-usage/references/mcp-tools.md` shows both MCP and CLI usage
- [ ] **Testing:** Integration tests verify CLI and MCP produce identical results

### Dependencies & Constraints

**Dependencies:**
- Existing shared utilities: `plan_display.ts`, `ready_plans.ts`, `plan_merge.ts`, `plans.ts`
- Existing MCP tool implementations in `generate_mode.ts` (to be refactored)
- Existing Zod schemas for tool parameters

**Technical Constraints:**
- Must maintain backward compatibility with existing MCP tools
- CLI tools must handle stdin reading properly (not blocking forever if no input)
- Must work with Bun's stdin handling

### Implementation Notes

#### Recommended Approach

**Phase 1: Create shared tool functions**

1. Create `src/rmplan/tools/` directory structure:
```
src/rmplan/tools/
├── index.ts              # Re-exports all
├── schemas.ts            # All Zod schemas (moved from generate_mode.ts)
├── context.ts            # ToolContext type definition
├── get_plan.ts           # getPlanTool()
├── create_plan.ts        # createPlanTool()
├── update_plan_tasks.ts  # updatePlanTasksTool()
├── update_plan_details.ts # updatePlanDetailsTool()
├── manage_plan_task.ts   # managePlanTaskTool()
└── list_ready_plans.ts   # listReadyPlansTool()
```

2. Define `ToolContext` and `ToolResult` interfaces:
```typescript
// src/rmplan/tools/context.ts
export interface ToolContext {
  config: RmplanConfig;
  gitRoot: string;
  log?: ToolLogger;  // Optional for MCP, not used by CLI
}

export interface ToolResult<T = unknown> {
  text: string;           // Human-readable text (MCP default, CLI default)
  data?: T;               // Structured data (for --json output)
  message?: string;       // Optional summary message
}
```

3. Each tool function returns a `ToolResult`:
```typescript
// src/rmplan/tools/get_plan.ts
export async function getPlanTool(
  args: GetPlanArguments,
  context: ToolContext
): Promise<ToolResult<PlanSchema>> {
  const { plan, planPath } = await resolvePlan(args.plan, context);
  const text = buildPlanContext(plan, planPath, context);
  return {
    text,
    data: plan,  // Full plan object for JSON output
    message: `Retrieved plan ${plan.id}: ${plan.title}`,
  };
}

// src/rmplan/tools/create_plan.ts
export async function createPlanTool(
  args: CreatePlanArguments,
  context: ToolContext
): Promise<ToolResult<{ id: number; path: string }>> {
  // ... create plan logic ...
  return {
    text: `Created plan ${nextId} at ${relativePath}`,
    data: { id: nextId, path: relativePath },
    message: `Created plan ${nextId}`,
  };
}

// src/rmplan/tools/list_ready_plans.ts
export async function listReadyPlansTool(
  args: ListReadyPlansArguments,
  context: ToolContext
): Promise<ToolResult<ReadyPlanSummary[]>> {
  // ... filter logic ...
  const jsonOutput = formatReadyPlansAsJson(readyPlans, { gitRoot: context.gitRoot });
  return {
    text: jsonOutput,  // Already JSON string for MCP compatibility
    data: readyPlans,  // Raw array for --json output
    message: `Found ${readyPlans.length} ready plans`,
  };
}
```

**Phase 2: Refactor MCP tools to use shared functions**

Update `generate_mode.ts`:
```typescript
import {
  getPlanTool,
  createPlanTool,
  // ... etc
  getPlanParameters,
  createPlanParameters,
  // ... etc
  type ToolResult,
} from '../tools/index.js';

// Helper to extract text from ToolResult for MCP compatibility
function toMcpResult(result: ToolResult): string {
  return result.text;
}

// Tool registration extracts .text for MCP compatibility:
server.addTool({
  name: 'get-plan',
  parameters: getPlanParameters,
  execute: async (args) => {
    const result = await getPlanTool(args, context);
    return toMcpResult(result);
  },
});

server.addTool({
  name: 'create-plan',
  parameters: createPlanParameters,
  execute: async (args, execContext) => {
    const result = await createPlanTool(args, {
      ...context,
      log: wrapLogger(execContext.log, '[create-plan] '),
    });
    return toMcpResult(result);
  },
});
```

**Phase 3: Create CLI command handler**

Add to `src/rmplan/rmplan.ts`:
```typescript
const toolsCommand = program.command('tools').description('Run MCP tool equivalents via CLI');

toolsCommand
  .command('get-plan')
  .description('Retrieve plan details (reads JSON from stdin)')
  .option('--json', 'Output as structured JSON')
  .action(async (options, command) => {
    const { handleToolCommand } = await import('./commands/tools.js');
    await handleToolCommand('get-plan', options, command).catch(handleCommandError);
  });

// ... similar for other tools, each with --json option
```

Create `src/rmplan/commands/tools.ts`:
```typescript
import {
  getPlanTool, createPlanTool, updatePlanTasksTool,
  updatePlanDetailsTool, managePlanTaskTool, listReadyPlansTool,
  getPlanParameters, createPlanParameters, // ... etc
  type ToolResult, type ToolContext,
} from '../tools/index.js';

interface ToolOptions {
  json?: boolean;
}

async function readJsonFromStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString('utf-8').trim();
  if (!input) {
    throw new Error('No JSON input received on stdin');
  }
  return JSON.parse(input);
}

// ToolResult imported from ../tools/index.js

const toolHandlers = {
  'get-plan': { schema: getPlanParameters, fn: getPlanTool },
  'create-plan': { schema: createPlanParameters, fn: createPlanTool },
  // ... etc
};

function formatOutput(result: ToolResult<unknown>, options: ToolOptions): string {
  if (options.json) {
    return JSON.stringify({
      success: true,
      result: result.data ?? result.text,
      message: result.message,
    }, null, 2);
  }
  return result.text;
}

function formatError(error: Error, options: ToolOptions): string {
  if (options.json) {
    return JSON.stringify({
      success: false,
      error: error.message,
      code: error.name === 'ZodError' ? 'VALIDATION_ERROR' : 'ERROR',
    }, null, 2);
  }
  return `Error: ${error.message}`;
}

export async function handleToolCommand(
  toolName: string,
  options: ToolOptions,
  command: any
): Promise<void> {
  const globalOpts = command.parent.parent.opts();

  try {
    const config = await loadEffectiveConfig(globalOpts.config);
    const pathContext = await resolvePlanPathContext(config);

    const context: ToolContext = {
      config,
      gitRoot: pathContext.gitRoot,
    };

    const handler = toolHandlers[toolName];
    if (!handler) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const rawInput = await readJsonFromStdin();
    const parsedArgs = handler.schema.parse(rawInput);
    const result = await handler.fn(parsedArgs, context);

    console.log(formatOutput(result, options));
  } catch (error) {
    console.error(formatError(error as Error, options));
    process.exit(1);
  }
}
```

**Phase 4: Add --no-tools option to MCP server**

Modify `src/rmplan/mcp/server.ts`:
```typescript
export interface StartMcpServerOptions {
  configPath?: string;
  transport?: 'stdio' | 'http';
  port?: number;
  noTools?: boolean;  // NEW
}

export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<void> {
  // ... existing setup ...

  registerGenerateMode(server, registrationContext, {
    registerTools: !options.noTools,  // NEW
  });

  // ... existing startup ...
}
```

Modify `registerGenerateMode()` in `generate_mode.ts`:
```typescript
interface RegisterOptions {
  registerTools?: boolean;
}

export function registerGenerateMode(
  server: FastMCP,
  context: GenerateModeRegistrationContext,
  options: RegisterOptions = {}
): void {
  const { registerTools = true } = options;

  // Always register prompts
  server.addPrompt({ ... });

  // Conditionally register tools
  if (registerTools) {
    server.addTool({ ... });
  }

  // Always register resources
  server.addResource({ ... });
}
```

Update CLI in `rmplan.ts`:
```typescript
program
  .command('mcp-server')
  .option('--no-tools', 'Run server without tools (prompts and resources only)')
  .action(async (options, command) => {
    await startMcpServer({
      configPath: globalOpts.config,
      transport,
      port: options.port,
      noTools: options.noTools,  // NEW
    });
  });
```

**Phase 5: Update documentation**

1. Update `claude-plugin/skills/rmplan-usage/SKILL.md`:
   - Add section on CLI tools as alternative to MCP
   - Update MCP integration section to mention CLI alternatives

2. Update `claude-plugin/skills/rmplan-usage/references/mcp-tools.md`:
   - Add CLI equivalent for each tool
   - Show stdin/stdout usage examples

3. Consider creating `claude-plugin/skills/rmplan-usage/references/cli-tools.md`:
   - Dedicated reference for CLI tool commands

#### Potential Gotchas

1. **Stdin reading in Bun:** Bun's stdin handling may differ from Node.js. Test with `process.stdin` iteration pattern shown above.

2. **Empty stdin:** If run without piped input, stdin.read() may block. Consider adding timeout or checking if stdin is a TTY:
   ```typescript
   if (process.stdin.isTTY) {
     throw new Error('This command requires JSON input on stdin');
   }
   ```

3. **Error output format:** CLI tools should write errors to stderr, success to stdout:
   ```typescript
   try {
     const result = await handler.fn(...);
     console.log(result);  // stdout
   } catch (error) {
     console.error(`Error: ${error.message}`);  // stderr
     process.exit(1);
   }
   ```

4. **Schema re-exports:** When moving schemas to `tools/schemas.ts`, ensure `generate_mode.ts` imports from the new location to avoid duplication.

5. **Commander --no-tools parsing:** Commander's negated options need careful handling. The option becomes `options.tools === false` when `--no-tools` is passed.

#### Conflicting, Unclear, or Impossible Requirements

None identified - the requirements are clear and achievable.

### Manual Testing Steps

1. **Test CLI tools work correctly:**
   ```bash
   # Get plan (text output)
   echo '{"plan": "123"}' | rmplan tools get-plan

   # Get plan (JSON output)
   echo '{"plan": "123"}' | rmplan tools get-plan --json

   # Create plan
   echo '{"title": "Test Plan", "priority": "medium"}' | rmplan tools create-plan
   echo '{"title": "Test Plan", "priority": "medium"}' | rmplan tools create-plan --json

   # List ready plans
   echo '{}' | rmplan tools list-ready-plans
   echo '{"priority": "high", "limit": 5}' | rmplan tools list-ready-plans --json
   ```

2. **Test MCP server with --no-tools:**
   ```bash
   # Start server without tools
   rmplan mcp-server --no-tools

   # Verify prompts still work, tools are not available
   # (use MCP client or inspector)
   ```

3. **Test that CLI and MCP produce same results:**
   ```bash
   # Compare outputs
   echo '{"plan": "123"}' | rmplan tools get-plan > cli-output.txt
   # Use MCP client to call get-plan with same args
   # Compare outputs
   ```

4. **Test error handling:**
   ```bash
   # Invalid JSON (text error)
   echo 'not json' | rmplan tools get-plan
   # Should error clearly

   # Invalid JSON (JSON error format)
   echo 'not json' | rmplan tools get-plan --json
   # Should output {"success": false, "error": "..."}

   # Missing required field
   echo '{}' | rmplan tools create-plan
   # Should show validation error

   # Missing required field (JSON format)
   echo '{}' | rmplan tools create-plan --json
   # Should output {"success": false, "error": "...", "code": "VALIDATION_ERROR"}

   # No stdin
   rmplan tools get-plan
   # Should error about missing input
   ```

### Step-by-Step Implementation Guide

1. **Create `src/rmplan/tools/` directory and files**
   - Move Zod schemas from `generate_mode.ts` to `tools/schemas.ts`
   - Create `tools/context.ts` with `ToolContext` interface
   - Create individual tool files, extracting logic from `generate_mode.ts`

2. **Update `generate_mode.ts` to use shared tools**
   - Import from `../tools/index.js`
   - Replace inline `mcp*` functions with calls to tool functions
   - Keep MCP-specific wrapper logic (logging, error handling)

3. **Add `tools` command to `rmplan.ts`**
   - Create command group with subcommands
   - Each subcommand calls `handleToolCommand()`

4. **Create `commands/tools.ts`**
   - Implement stdin reading
   - Implement command routing
   - Implement context setup

5. **Add `--no-tools` to MCP server**
   - Update `StartMcpServerOptions`
   - Update `registerGenerateMode()` signature
   - Update CLI command registration

6. **Write tests**
   - Unit tests for each tool function
   - Integration tests comparing CLI and MCP outputs
   - Tests for error handling

7. **Update documentation**
   - SKILL.md
   - mcp-tools.md (add CLI alternatives)
   - Consider new cli-tools.md reference

8. **Run full test suite and manual verification**

Implemented shared rmplan tool modules and wired them into both MCP and CLI paths (Tasks: Create src/rmplan/tools directory and files; Update generate_mode.ts to use shared tools; Add tools command to rmplan.ts; Create commands/tools.ts; Add --no-tools option to MCP server). Added `src/rmplan/tools/context.ts` with ToolContext/ToolResult and logger typing, and moved all MCP tool parameter schemas into `src/rmplan/tools/schemas.ts` (exported from `src/rmplan/tools/index.ts` and re-exported from `src/rmplan/mcp/generate_mode.ts` for compatibility). Implemented tool functions in `src/rmplan/tools/get_plan.ts`, `create_plan.ts`, `update_plan_tasks.ts`, `update_plan_details.ts`, `manage_plan_task.ts`, and `list_ready_plans.ts` to encapsulate plan mutations, reuse existing helpers (`resolvePlan`, `mergeTasksIntoPlan`, `updateDetailsWithinDelimiters`, `validateTags`, `formatReadyPlansAsJson`), and return ToolResult with text plus structured data for JSON output. Updated `src/rmplan/mcp/generate_mode.ts` to call these shared tools via thin mcp* wrappers (using a new toMcpResult helper), added a RegisterOptions/registerTools switch to conditionally register MCP tools, and removed duplicated logic from generate_mode while keeping prompts/resources intact. Updated `src/rmplan/commands/show.ts` and `src/rmplan/commands/ready.ts` MCP helper functions to call the new tools for get-plan/list-ready-plans. Added `src/rmplan/commands/tools.ts` to implement stdin JSON parsing (with TTY guard), zod validation, structured JSON output via `--json`, and consistent error formatting; wired new `rmplan tools <tool-name>` subcommands in `src/rmplan/rmplan.ts`. Added `--no-tools` to MCP server options in `src/rmplan/mcp/server.ts` and CLI to run prompts/resources only, and documented the new flag plus CLI fallback in `README.md`. Key design decisions: keep error messages identical to existing MCP behavior; keep schema single source of truth in tools/schemas; pass logging through ToolContext to avoid MCP-only dependencies; preserve backward-compatible exports from generate_mode while centralizing tool logic. Integration points include MCP tool registration, CLI tool execution, and existing plan/task update helpers. No deviations from the plan beyond adding a minimal README mention for the new CLI/flag.

Tasks: fix the --no-tools flag handling, preserve manage-plan-task JSON data, restore MCP create-plan UserError behavior, and add CLI/MCP parity coverage for update-plan-details, update-plan-tasks, manage-plan-task, and list-ready-plans.

Implementation details: updated `src/rmplan/rmplan.ts` to derive `noTools` from Commander’s negated `--no-tools` option via `options.tools === false`. Updated `src/rmplan/tools/manage_plan_task.ts` to merge the action tag into the underlying add/update/remove tool data so JSON results retain fields like `index`/`shifted`. Wrapped `createPlanTool` errors in `src/rmplan/mcp/generate_mode.ts` with `UserError` to restore MCP user-facing error semantics without changing the shared tool behavior. Added parity tests in `src/rmplan/commands/tools.test.ts` for update-plan-details, update-plan-tasks, manage-plan-task (including JSON payload assertions), and list-ready-plans; tests compare CLI output with shared tool output and MCP wrapper output, reset plan files between runs to avoid mutation side effects, and use a noop logger for `mcpUpdatePlanTasks`.

Tasks worked: Task 7 (Update documentation). Updated claude-plugin/skills/rmplan-usage/SKILL.md to document CLI tool equivalents for MCP tools, including JSON stdin usage, --json structured output, and the rmplan mcp-server --no-tools prompt/resource-only mode. Expanded claude-plugin/skills/rmplan-usage/references/mcp-tools.md with a general CLI equivalence note plus per-tool CLI examples (get-plan, create-plan, update-plan-tasks, update-plan-details, manage-plan-task, list-ready-plans) to keep schemas and behaviors aligned. Extended claude-plugin/skills/rmplan-usage/references/cli-commands.md with a dedicated rmplan tools section and sample commands, opting to fold CLI tool docs into the existing CLI reference instead of adding a new cli-tools.md file. This keeps the CLI and MCP docs in sync and gives agents a clear fallback path when MCP tools are unavailable.

Fixed create-plan parent validation and parity tests. For the create-plan tool, I now resolve the parent plan (via readAllPlans) before writing the new plan file so an invalid parent ID fails fast and no orphan plan file is left behind; the resolved parent plan is then reused for dependency/status updates after the child plan is written. For CLI/MCP parity, I adjusted the update-plan-details and update-plan-tasks tests to reset the plan file before each run (shared tool, CLI handler, MCP wrapper) so all three execute against identical starting content and the output comparison is meaningful. Tasks worked on: fix create-plan failure behavior when parent is invalid; make CLI/MCP parity tests start from the same plan state. Files touched: src/rmplan/tools/create_plan.ts, src/rmplan/commands/tools.test.ts. Key decisions: validate parent before write to avoid partial success; reuse the cached parent plan to avoid duplicate reads; reinitialize plan fixtures between each update run to remove hidden state. No deviations from plan beyond these minimal changes.

Completed Task 8 (Run full test suite and manual verification). Ran bun test and confirmed 2382 passing tests with 85 skipped tests; the existing rmfix warnings still appear. Manually exercised rmplan tools get-plan --json for plan 148 and rmplan tools list-ready-plans --json with empty input to confirm stdin JSON parsing and structured output without mutating plans. Started rmplan mcp-server --no-tools briefly and terminated after startup to confirm the flag wiring; observed a harmless nice(5) warning in the shell but no functional errors. No code changes were required for this task; the only file change was the plan progress note, committed via jj.
