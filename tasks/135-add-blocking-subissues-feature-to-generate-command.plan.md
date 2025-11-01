---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add blocking subissues feature to generate command
goal: ""
id: 135
uuid: ac0b9e9d-cd95-45f1-8ded-15074bd6c800
generatedBy: agent
status: in_progress
priority: medium
container: false
temp: false
dependencies:
  - 129
parent: 128
references:
  "128": f69d418b-aaf1-4c29-88a9-f557baf8f81e
  "129": 1993c51d-3c29-4f8d-9928-6fa7ebea414c
issue: []
pullRequest: []
docs: []
planGeneratedAt: 2025-11-01T19:45:53.007Z
promptsGeneratedAt: 2025-11-01T19:45:53.007Z
createdAt: 2025-10-26T22:41:26.645Z
updatedAt: 2025-11-01T20:21:49.184Z
progressNotes:
  - timestamp: 2025-11-01T19:59:48.737Z
    text: Added CLI flag, prompt instructions, and blocking plan detection snapshot
      logic. Updated Claude/simple prompts to include rmplan add guidance and
      blocking summary section, and wired withBlockingSubissues option through
      CLI and MCP pathways.
    source: "implementer: tasks 1-3"
  - timestamp: 2025-11-01T20:03:27.624Z
    text: Reviewed generate command changes and test suite. Existing tests only
      cover prompt text; no assertions around new blocking plan
      detection/reporting or warn path when blockers missing. Planning to add
      targeted tests.
    source: "tester: tasks 9-11"
  - timestamp: 2025-11-01T20:11:51.866Z
    text: Added CLI blocking-plan detection tests covering successful creation,
      unrelated plan warning, and missing numeric ID guard. bun test
      src/rmplan/commands/generate.test.ts passes. Full bun test currently fails
      due to task-management integration test importing addPlanTaskParameters
      from generate_mode.ts, which no longer exports that symbol (pre-existing
      issue).
    source: "tester: tasks 9-11"
tasks:
  - title: Add --with-blocking-subissues CLI flag
    done: true
    description: Add the new boolean flag to the generate command definition in
      src/rmplan/rmplan.ts. Follow existing patterns for boolean flags
      (--autofind, --commit, etc.). No default value needed - flag presence
      enables the feature.
  - title: Update multi-phase prompt generation
    done: true
    description: Modify generateClaudeCodePlanningPrompt() in src/rmplan/prompt.ts
      to accept an optional withBlockingSubissues parameter. When true, append
      the blocking subissues section to the prompt. This section should instruct
      the LLM to identify prerequisite work and format it with title, priority,
      reason, and high-level tasks.
  - title: Update simple mode prompt generation
    done: true
    description: Modify generateClaudeCodeSimplePlanningPrompt() in
      src/rmplan/prompt.ts to also support the withBlockingSubissues parameter.
      Use similar but more concise wording appropriate for simple mode.
  - title: Update MCP generate-plan prompt
    done: true
    description: Modify loadResearchPrompt() in src/rmplan/mcp/generate_mode.ts to
      check for a withBlockingSubissues option and pass it to the prompt
      generation functions. The MCP prompt should support the same blocking
      subissues detection as CLI.
  - title: Update MCP generate-plan-simple prompt
    done: true
    description: Modify loadGeneratePrompt() in src/rmplan/mcp/generate_mode.ts to
      support withBlockingSubissues option, ensuring simple mode via MCP also
      has this capability.
  - title: Add tests for prompt generation
    done: true
    description: Add tests in src/rmplan/commands/generate.test.ts (or create if
      needed) to verify that when withBlockingSubissues is true, the generated
      prompts include the blocking subissues section. Test both multi-phase and
      simple mode variants.
  - title: Add integration test for end-to-end flow
    done: false
    description: "Create an integration test that mocks an LLM agent which calls
      `rmplan add` commands during execution. Verify: new plans are created,
      parent/discoveredFrom relationships are set correctly, main plan
      dependencies are updated automatically, detection logic correctly
      identifies the new plans and reports them."
  - title: Update CLI help and documentation
    done: false
    description: Ensure the --with-blocking-subissues flag appears in help text with
      clear description. Update README.md to document the new feature with
      example usage and expected LLM response format.
  - title: Snapshot plan IDs before LLM invocation
    done: true
    description: In handleGenerateCommand(), before calling
      invokeClaudeCodeForGeneration(), capture the list of existing plan IDs
      using readAllPlans(). Store this snapshot to compare against after LLM
      execution.
    files: []
    docs: []
    steps: []
  - title: Add rmplan add instructions to prompts
    done: true
    description: "Update the prompt generation functions to include instructions for
      creating blocking plans. Tell the LLM: 'If you identify prerequisite work
      that should be done first, create those as separate plans using `rmplan
      add \\\"Plan Title\\\" --parent CURRENT_ID --discovered-from CURRENT_ID
      --priority [high|medium|low] --details \\\"Description of why this is
      needed\\\"`. The parent plan's dependencies will be updated
      automatically.'"
    files: []
    docs: []
    steps: []
  - title: Detect and report newly created plans
    done: true
    description: "After LLM execution completes, call readAllPlans() again and
      compare against the snapshot. Identify new plan IDs that weren't present
      before. For each new plan, check if it has parent or discoveredFrom
      matching current plan ID. Log a summary: 'Created N blocking plans: #ID
      Title, #ID Title, ...'"
    files: []
    docs: []
    steps: []
changedFiles:
  - src/rmplan/commands/generate.test.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/mcp/generate_mode.ts
  - src/rmplan/prompt.ts
  - src/rmplan/rmplan.ts
rmfilter: []
---

## Overview

Enhance `rmplan generate` to help agents identify prerequisite work that should be done first. This adds a `--with-blocking-subissues` flag that prompts the LLM to identify blocking work, then offers to create those as separate plans with proper dependencies.

## Changes Required

### 1. Add CLI Flag

File: `src/rmplan/rmplan.ts` (in the generate command definition)

```typescript
.option('--with-blocking-subissues', 'Prompt LLM to identify and create blocking prerequisite plans')
```

### 2. Update Prompt Generation

File: `src/rmplan/commands/generate.ts`

When `options.withBlockingSubissues` is true, add this section to the LLM prompt:

```markdown
# Blocking Subissues

Before proposing the main implementation tasks, identify any prerequisite work
that should be completed first. For each prerequisite:
1. Determine if it should be a separate plan
2. Suggest a title, priority, and relationship to this plan
3. Explain why it's a prerequisite

Format blocking subissues as:
## Blocking Subissue: [Title]
- Priority: [high|medium|low]
- Relationship: [dependency|research|infrastructure]
- Reason: [Why this must be done first]
- Tasks: [High-level task list]
```

### 3. Parse and Create Subissues

After the LLM responds, parse the blocking subissues section:

```typescript
const blockingRegex = /## Blocking Subissue: (.+?)\n- Priority: (.+?)\n- Relationship: (.+?)\n- Reason: (.+?)\n- Tasks: ([\s\S]+?)(?=## Blocking Subissue:|$)/g;

const subissues = [];
let match;
while ((match = blockingRegex.exec(llmOutput)) !== null) {
  subissues.push({
    title: match[1].trim(),
    priority: match[2].trim(),
    relationship: match[3].trim(),
    reason: match[4].trim(),
    tasks: match[5].trim(),
  });
}
```

Then offer to create them:

```typescript
if (subissues.length > 0) {
  log(chalk.yellow(`\nLLM identified ${subissues.length} blocking subissues`));
  
  const shouldCreate = await confirm({
    message: 'Create these as separate plans?',
    default: true,
  });
  
  if (shouldCreate) {
    const createdIds = [];
    for (const subissue of subissues) {
      // Create plan using rmplan add command programmatically
      const newPlanId = await createPlan({
        title: subissue.title,
        priority: subissue.priority,
        parent: currentPlanId, // if this is part of a hierarchy
        details: `${subissue.reason}\n\n## Tasks\n${subissue.tasks}`,
      });
      createdIds.push(newPlanId);
    }
    
    // Add created plan IDs as dependencies to current plan
    await updatePlanDependencies(currentPlanId, createdIds);
    
    log(chalk.green(`✓ Created ${createdIds.length} blocking plans: ${createdIds.join(', ')}`));
  }
}
```

## Example Usage

```bash
# Generate plan with blocking subissue detection
rmplan generate 42 --with-blocking-subissues
```

LLM might respond:

```
## Blocking Subissue: Set up authentication infrastructure
- Priority: high
- Relationship: infrastructure
- Reason: The main tasks require auth middleware which doesn't exist yet
- Tasks:
  1. Install passport.js and configure strategies
  2. Create auth middleware
  3. Add user session management

## Blocking Subissue: Research rate limiting approaches
- Priority: medium  
- Relationship: research
- Reason: Need to decide on rate limiting strategy before implementing endpoints
- Tasks:
  1. Compare redis-based vs in-memory solutions
  2. Document decision and rationale
```

Then the command would offer to create plans 143 (auth infrastructure) and 144 (research), and update plan 42 to depend on them.

## Use Case

This helps agents:
1. Break down work more granularly
2. Avoid starting implementation before prerequisites are ready
3. Track why certain work needs to happen in a specific order
4. Use `discoveredFrom` to link the subissues back to the parent plan

## Testing

- Generate with flag, verify prompt includes blocking subissue section
- Mock LLM response with subissues, verify parsing works
- Accept creation prompt, verify plans are created with correct fields
- Decline creation prompt, verify plans are not created
- Verify dependencies are added correctly to parent plan

## Dependencies

Depends on plan 129 for `discoveredFrom` field (subissues should be marked with `--discovered-from <parent-plan-id>`).

<!-- rmplan-generated-start -->
## Implementation Decisions

Based on research and discussion:

1. **Blocking subissues will use both `parent` and `dependencies`:**
   - Created plans have `parent` set to the main plan ID
   - Created plans have `discoveredFrom` set to the main plan ID
   - Main plan's `dependencies` array includes the new subissue IDs
   - This provides hierarchical organization AND execution blocking

2. **No "relationship" field needed:**
   - The reason field already captures why it's blocking
   - No need for redundant categorization (dependency/research/infrastructure)

3. **No user confirmation:**
   - Automatically create all blocking subissues identified by LLM
   - Report what was created afterward
   - Simpler UX, matches existing command patterns

4. **LLM Response Format:**
   ```markdown
   ## Blocking Subissue: [Title]
   - Priority: [high|medium|low|urgent]
   - Reason: [Why this must be done first]
   - Tasks: [High-level task list]
   ```

5. **Support in both modes:**
   - Works with default multi-phase planning
   - Works with `--simple` mode
   - Same flag, slightly different prompt text for simple mode

## Revised Approach: Agent-Driven Plan Creation

**Key Change:** Instead of parsing LLM output for a specific format, the LLM agent will directly use `rmplan add` commands to create blocking subissues.

**Benefits:**
- No fragile regex parsing needed
- LLM uses existing, well-tested plan creation logic
- More flexible - LLM can set any valid plan properties
- Simpler implementation - just detect what plans were created

**Implementation Flow:**
1. Before invoking LLM, snapshot existing plan IDs
2. Add instruction to prompt: "If you identify blocking work, create those plans using `rmplan add` with appropriate `--parent`, `--discovered-from`, and `--depends-on` flags"
3. After LLM execution, compare plan directory to find newly created plans
4. Report the new blocking plans to user with IDs and titles

**Agent Tool Access:**
- The agent already has access to bash commands including `rmplan add`
- Can set all needed relationships via CLI flags: `--parent ID --discovered-from ID --depends-on ID`
- The bidirectional parent/dependency updates happen automatically via existing code
<!-- rmplan-generated-end -->

## Research

### Summary

The feature to add blocking subissues detection to the `rmplan generate` command is well-positioned within the existing architecture. The codebase already has strong patterns for:
- Programmatic plan creation (both CLI and MCP)
- Parent-child relationship management with automatic bidirectional updates
- The `discoveredFrom` field (mentioned as dependency plan 129)
- LLM prompt construction and response parsing
- CLI flag definitions and validation

The most critical discoveries:
1. Both CLI and MCP paths for plan creation already exist and maintain consistency through shared utilities
2. The generate command supports multiple modes (Claude Code, direct, clipboard) that all need the new prompt section
3. Parent-child relationships are automatically maintained bidirectionally, simplifying the implementation
4. The MCP server has separate prompts that mirror CLI functionality and will need parallel updates

### Findings

#### 1. Generate Command Structure (src/rmplan/commands/generate.ts)

**Key Discoveries:**

The `handleGenerateCommand` function (lines 177-811) is the main entry point with comprehensive option handling:

**Input Sources** (mutually exclusive):
- `planArg`: Positional argument for plan file/ID
- `--plan <plan>`: Specific plan file
- `--plan-editor`: Opens editor to create plan text
- `--issue <url|number>`: Fetch plan from GitHub issue
- `--next-ready <planIdOrPath>`: Find next dependency to generate
- `--latest`: Find most recently updated plan
- `--use-yaml <file>`: Skip generation, use existing YAML

**Prompt Generation Pattern (lines 500-517):**
```typescript
const promptString = options.simple ? simplePlanPrompt(fullPlanText) : planPrompt(fullPlanText);

let fullPlanText = planText;
if (planningDocContent) {
  fullPlanText = `${planText}\n\n## Planning Rules\n\n${planningDocContent}`;
}
```

**Three Processing Paths for LLM Interaction:**

1. **Claude Code Mode (default)** - lines 525-588:
   - Skips rmfilter, uses Claude Code orchestrator
   - Calls `generateClaudeCodePlanningPrompt()`, `generateClaudeCodeGenerationPrompt()`, `generateClaudeCodeResearchPrompt()`
   - Invokes `invokeClaudeCodeForGeneration()` with planning and generation prompts
   - Optionally captures research findings

2. **Direct Mode** (`--direct`) - lines 589-620:
   - Runs LLM directly on rmfilter output
   - Uses `runStreamingPrompt()` with temperature 0.1

3. **Traditional Clipboard Mode** - lines 621-677:
   - Prompts user to paste output manually
   - Calls `waitForEnter(true)` for interactive input

**All modes converge on:**
- `extractMarkdownToYaml()` function for parsing LLM response (lines 680-776)
- Handles both YAML and Markdown input formats
- Validates against `planSchema`
- Preserves metadata from original plan

**CLI Interaction Patterns:**
- Uses `@inquirer/prompts` for user input
- Uses `chalk` for colored terminal output
- Linear execution flow (no complex multi-step wizards)

**Post-Generation Processing:**
- Auto-runs extract command unless `--no-extract`
- Optional commit with `--commit` flag
- Preserves completed tasks when updating plans

**Key Files for Prompt Construction:**
- `src/rmplan/prompt.ts` - Contains all prompt generation functions
- Planning document integration via `config.planning?.instructions`

#### 2. MCP Server Integration (src/rmplan/mcp/generate_mode.ts)

**MCP Prompts Registered (lines 717-794):**

1. **`generate-plan`** - Full research + generation workflow
2. **`plan-questions`** - Interactive collaboration questions
3. **`compact-plan`** - Archival compaction for completed plans
4. **`generate-plan-simple`** - Direct generation without research phase
5. **`load-plan`** - Display plan context for review

**Prompt Loading Functions (lines 33-146):**

- `loadResearchPrompt()` (lines 33-65) - Returns research phase prompt, redirects to `loadGeneratePrompt()` if `plan.simple === true`
- `loadQuestionsPrompt()` (lines 67-90) - For iterative collaboration
- `loadGeneratePrompt()` (lines 114-146) - Direct generation mode
- `loadPlanPrompt()` (lines 92-112) - Display full context
- `loadCompactPlanPrompt()` - In `prompts/compact_plan.ts` (lines 13-71)

**Key Differences from CLI:**

| Aspect | CLI | MCP |
|--------|-----|-----|
| Usage Pattern | Two-phase flow with `rmfilter` | Built-in prompts for tool usage |
| Research Handling | Via `invokeClaudeCodeForGeneration()` | Via `generateClaudeCodeResearchPrompt()` + `append-plan-research` tool |
| Prompt Generation | Builds full text prompts sent to Claude | Returns structured prompt objects with `messages[0].content.text` |
| Tool Integration | LLM edits via `extractMarkdownToYaml()` | Direct MCP tools: `update-plan-tasks`, `manage-plan-task`, `append-plan-research` |
| Interaction Model | Clipboard-based or direct LLM call | Interactive with human feedback loops |
| Simple Mode | Controlled by `--simple` flag | `loadResearchPrompt()` checks `plan.simple` field |

**MCP Tools Available (lines 796-915):**
- `update-plan-tasks` - Bulk task updates
- `manage-plan-task` - Add/update/remove individual tasks
- `append-plan-research` - Append research findings
- `get-plan` - Retrieve plan details
- `update-plan-details` - Modify plan details
- `list-ready-plans` - List ready-to-execute plans
- `create-plan` - Create new plan files

**Underlying Prompt Functions (src/rmplan/prompt.ts):**
- `generateClaudeCodePlanningPrompt()` - Lines 602-646
- `generateClaudeCodeResearchPrompt()` - Lines 648-677
- `generateClaudeCodeGenerationPrompt()` - Lines 679-719
- `generateClaudeCodeSimplePlanningPrompt()` - Lines 721-760

**Context Building:**
- Uses `buildPlanContext()` from `src/rmplan/plan_display.ts` to assemble plan information
- Includes ID, title, goal, details, status, priority, assignments, task summary, relationships, dependencies

#### 3. Plan Creation Utilities (src/rmplan/commands/add.ts and src/rmplan/mcp/generate_mode.ts)

**Two Main Creation Pathways:**

1. **CLI Command: `handleAddCommand`** (add.ts, lines 17-234)
   - Validates configuration and resolves target directory
   - Loads all existing plans to check for parent validity
   - Generates unique numeric ID via `generateNumericPlanId(tasksDir)`
   - Creates filename via `generatePlanFilename(planId, title)`
   - Creates `PlanSchema` object with auto-generated UUID
   - Updates parent plan's dependencies (bidirectional)
   - Writes plan file via `writePlanFile(filePath, plan)`
   - Optionally opens in editor

2. **MCP Tool: `mcpCreatePlan`** (generate_mode.ts, lines 632-711)
   - Similar flow to CLI command
   - Returns success message with plan ID and path
   - Supports all plan metadata fields via Zod schema

**Core Utilities:**

- **ID Generation** (`src/rmplan/id_utils.ts`):
  ```typescript
  generateNumericPlanId(tasksDir: string): Promise<number>
  // Returns maxId + 1, sequential
  ```

- **Filename Generation** (`src/rmplan/utils/filename.ts`):
  ```typescript
  generatePlanFilename(planId: number, title: string): string
  // Format: 001-plan-title.plan.md (zero-padded to 3 digits)
  ```

- **Reading Plans** (`src/rmplan/plans.ts`, lines 526-606):
  ```typescript
  readPlanFile(filePath: string): Promise<PlanSchema>
  // Supports YAML front matter + markdown body
  // Auto-generates UUID if missing
  ```

- **Writing Plans** (`src/rmplan/plans.ts`, lines 615-662):
  ```typescript
  writePlanFile(filePath: string, input: PlanSchemaInput, options?: { skipUpdatedAt?: boolean })
  // Updates updatedAt timestamp
  // Separates details field into markdown body
  ```

- **Reading All Plans** (`src/rmplan/plans.ts`, lines 55-161):
  ```typescript
  readAllPlans(directory: string, readCache = true)
  // Returns Map of ID → plan with filename
  // Detects duplicates and maintains UUID mappings
  // Cached for performance (clear with clearPlanCache())
  ```

**Parent-Child Relationship Management:**

Both `add.ts` (lines 177-202) and `mcpCreatePlan` (lines 671-702) automatically:
1. Check if parent plan exists
2. Add new plan ID to parent's `dependencies` array
3. If parent was `done`, reactivate to `in_progress`
4. Persist updated parent plan
5. Log relationship changes

**discoveredFrom Field:**
- Type: Optional `number` (plan ID)
- Purpose: Tracks which plan led to discovering a sub-plan during research/implementation
- Validated by `validateDiscoveredFromReferences()` in `src/rmplan/commands/validate.ts`
- Can be cleared with `rmplan set --no-discovered-from`

**Dependency Management:**

- **Circular Dependency Detection** (`src/rmplan/commands/validate.ts`, lines 256-310):
  ```typescript
  wouldCreateCircularDependency(plans, parentId, childId): boolean
  // Uses depth-first search to prevent cycles
  ```

- **Dependency Traversal** (`src/rmplan/plans.ts`, lines 464-517):
  ```typescript
  collectDependenciesInOrder(planId, allPlans, visited)
  // Topological sort: dependencies before dependents
  // Detects circular dependencies and throws error
  ```

- **Readiness Checks** (`src/rmplan/plans.ts`, lines 434-462):
  ```typescript
  isPlanReady(plan, allPlans): boolean
  // Status is 'pending'
  // All dependencies have status 'done'
  ```

**Plan Relationship Traversal:**
- `getBlockedPlans()` - Returns plans that list planId in their dependencies
- `getChildPlans()` - Returns plans with parent === planId
- `getDiscoveredPlans()` - Returns plans with discoveredFrom === planId

**Set Command for Updates** (`src/rmplan/commands/set.ts`):
- Changing parent automatically removes from old parent's dependencies
- Setting parent checks for circular dependencies
- Marks parent as `in_progress` if it was `done` (and new child added)

**Validation and Consistency** (`src/rmplan/commands/validate.ts`):
- `validateParentChildRelationships()` (lines 162-230) - Checks bidirectional consistency
- `fixParentChildRelationships()` - Auto-repair for inconsistencies

#### 4. CLI Flag Patterns (src/rmplan/rmplan.ts)

**Framework: Commander.js**
- Options defined via `.option()` method
- Chained on Command instances

**Boolean Flag Examples:**

Simple boolean flags (no value required):
```typescript
.option('--latest', 'Use the most recently updated plan')
.option('--plan-editor', 'Open plan in editor')
.option('--autofind', 'Automatically find relevant files')
.option('--quiet', 'Suppress informational output')
.option('--commit', 'Commit changes after successful plan generation')
.option('--direct', 'Call LLM directly instead of clipboard')
```

Negatable flags (mutually exclusive pairs):
```typescript
.option('--no-extract', 'Do not automatically run extract command')
.option('--no-direct', 'Use clipboard mode even if direct mode configured')
.option('--no-claude', 'Use traditional copy/paste mode instead of Claude Code')
```

**Options with Values:**

String values:
```typescript
.option('--mode <mode>', 'MCP server mode', 'generate')
.option('--editor <editor>', 'Editor to use (defaults to $EDITOR)')
.option('-o, --output <file>', 'Write result to file instead of stdout')
.option('--issue <url>', 'GitHub issue number or URL')
```

Integer values with validation:
```typescript
.option('--port <port>', 'Port to listen on', (value) => {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) throw new Error(`Invalid port: ${value}`);
  return parsed;
})
```

Enum/choice validation:
```typescript
.option('-p, --priority <level>', 'Priority level', (value) => {
  if (!prioritySchema.options.includes(value)) {
    throw new Error(`Priority must be one of: ${prioritySchema.options.join(', ')}`);
  }
  return value;
})
```

Multi-value options (arrays):
```typescript
.option('-d, --depends-on <ids...>', 'Specify plan IDs that this plan depends on')
.option('--rmfilter <files...>', 'Set rmfilter files (comma-separated or multiple)')
.option('-i, --issue <urls...>', 'Add GitHub issue URLs')
```

**Helper Function for Array Conversion:**
```typescript
function intArg(value: string | string[] | undefined): number | number[] | undefined
// Converts string arrays to numbers with validation
```

**How Options Are Passed:**
```typescript
.action(async (planArg, options, command) => {
  await handleGenerateCommand(planArg, options, command);
})
// options object contains all parsed flags
// command.parent.opts() accesses global options
```

**Default Values:**
```typescript
.option('--format <format>', 'Output format', 'list')  // Default: 'list'
.option('--require-workspace', 'Fail if...', false)    // Default: false
```

**Short and Long Forms:**
```typescript
-c, --config
-d, --depends-on
-p, --priority
-s, --status
-v, --verbose
```

#### 5. Testing Patterns

**Test File Locations:**

Core infrastructure:
- `src/testing.ts` - ModuleMocker class

Best examples:
- `src/rmplan/commands/set-task-done.test.ts` - Module mocking patterns
- `src/rmplan/commands/find_next_dependency.test.ts` - Filesystem operations, complex scenarios
- `src/rmplan/executors/codex_cli.test.ts` - LLM/executor mocking
- `src/rmplan/commands/task-management.integration.test.ts` - CLI/MCP integration
- `src/rmplan/commands/agent/agent.failure_handling.test.ts` - Agent workflows

**Key Testing Patterns:**

1. **Real Filesystem Operations:**
   ```typescript
   const tmpDir = await fs.mkdtemp(path.join(tmpdir(), 'rmplan-test-'));
   // Use real temp directories, not mocked filesystem
   ```

2. **Module Mocking with ModuleMocker:**
   ```typescript
   const moduleMocker = new ModuleMocker();
   
   afterEach(() => {
     moduleMocker.clear();
   });
   
   await moduleMocker.mock('./services/token.ts', () => ({
     getBucketToken: mock(() => { throw new Error('Unexpected error'); })
   }));
   ```

3. **Plan Cache Management:**
   ```typescript
   import { clearPlanCache } from '../plans.js';
   
   beforeEach(() => clearPlanCache());
   afterEach(() => clearPlanCache());
   ```

4. **YAML Plan Files:**
   ```typescript
   const planContent = `---
   # yaml-language-server: $schema=...
   id: 1
   title: Test Plan
   status: pending
   createdAt: ${new Date().toISOString()}
   updatedAt: ${new Date().toISOString()}
   tasks: []
   ---`;
   await fs.writeFile(path.join(tasksDir, '001-test.plan.md'), planContent);
   ```

5. **Spy Mocks for Verification:**
   ```typescript
   const logSpy = mock(() => {});
   await moduleMocker.mock('../commands/log.ts', () => ({ log: logSpy }));
   
   expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Success'));
   ```

6. **LLM Response Mocking:**
   ```typescript
   await moduleMocker.mock('../executors/index.ts', () => ({
     executeStep: mock(async () => ({
       success: true,
       output: 'Generated YAML content here...',
     }))
   }));
   ```

7. **Multi-stage Pipeline Testing:**
   ```typescript
   // Mock implementer → tester → reviewer → fixer stages
   const executeStepMock = mock()
     .mockResolvedValueOnce({ success: true, output: 'implementation' })
     .mockResolvedValueOnce({ success: true, output: 'test results' })
     .mockResolvedValueOnce({ success: true, output: 'review results' });
   ```

**Test Utilities:**
- `src/rmplan/utils/task_operations.ts` - findTaskByTitle(), selectTaskInteractive(), promptForTaskInfo()
- `src/rmplan/plans.ts` - readPlanFile(), writePlanFile(), clearPlanCache()
- `src/rmplan/configSchema.ts` - getDefaultConfig() for test setup

**Critical Testing Note:**
From CLAUDE.md: "Tests should be useful; if a test needs to mock almost all of the functionality, then it should probably not be written."

### Risks & Constraints

1. **Prompt Injection Risk:**
   - LLM responses must be carefully parsed to prevent malicious content
   - Regex patterns for extracting blocking subissues must be robust
   - Consider: What if LLM generates malformed YAML or tries to inject commands?

2. **Circular Dependency Creation:**
   - Creating multiple subissues with dependencies could create cycles
   - Must validate the full dependency graph before creating plans
   - The existing `wouldCreateCircularDependency()` function should be called for each new subissue

3. **Parent-Child vs Dependencies Confusion:**
   - The feature description mentions both `parent` and `dependsOn`
   - Need to clarify: Should blocking subissues be `parent` (hierarchical) or `dependencies` (execution order)?
   - Current recommendation: Use `dependencies` for blocking work, `parent` for organizational hierarchy

4. **discoveredFrom Dependency:**
   - The feature depends on plan 129 for `discoveredFrom` field
   - Need to verify this field is implemented and validated
   - From findings: Field exists in schema and is validated by `validateDiscoveredFromReferences()`

5. **Prompt Synchronization:**
   - Need to update prompts in THREE places:
     1. CLI generate command prompts (`src/rmplan/prompt.ts`)
     2. MCP generate-plan prompt loading (`src/rmplan/mcp/generate_mode.ts`)
     3. Simple mode variants
   - Risk of inconsistency if one is updated but not others

6. **Simple Mode Handling:**
   - Feature description doesn't mention simple mode
   - Should blocking subissues be supported in simple mode?
   - Recommendation: Support it in both modes but with simpler prompt in simple mode

7. **LLM Response Reliability:**
   - LLM may not always follow the exact format for blocking subissues
   - Need robust parsing with fallback handling
   - Consider: What if LLM doesn't include all required fields (priority, relationship, reason)?

8. **User Experience:**
   - Creating many subissues could be overwhelming
   - Need clear confirmation step with option to review/edit before creation
   - Should allow selective creation (checkbox interface for which subissues to create)

9. **Testing Complexity:**
   - Need to mock LLM responses with blocking subissue format
   - Need to test both confirmation acceptance and rejection
   - Need to test circular dependency prevention
   - Need to test bidirectional relationship updates

10. **Relationship Field Naming:**
    - The proposed "relationship" field (dependency|research|infrastructure) is not part of PlanSchema
    - This should be captured in plan details or a custom field
    - Recommendation: Include in generated plan's `details` field rather than as structured metadata

### Follow-up Questions

1. **Parent vs Dependencies:** Should blocking subissues be created as:
   - **Option A:** Children plans (with `parent` field) AND dependencies (in main plan's `dependencies` array)?
   - **Option B:** Just dependencies without parent-child relationship?
   - **Recommendation:** Option A provides better organization and allows hierarchical browsing

2. **Relationship Field Storage:** The proposed "relationship" field (dependency|research|infrastructure) is not in PlanSchema. Should we:
   - **Option A:** Add a new `relationship` field to PlanSchema?
   - **Option B:** Include it in the plan's `details` markdown as a tagged section?
   - **Option C:** Use plan title prefixes like "[Research]" or "[Infrastructure]"?
   - **Recommendation:** Option B (details field) to avoid schema changes, but open to discussion

3. **Confirmation UX:** When multiple blocking subissues are identified, should we:
   - **Option A:** Show all at once and ask for blanket yes/no confirmation?
   - **Option B:** Show list with checkboxes to select which ones to create?
   - **Option C:** Iterate through each one asking individually?
   - **Recommendation:** Option B for better user control, but needs more complex CLI interaction

4. **Simple Mode Support:** Should the `--with-blocking-subissues` flag work in simple mode?
   - **If yes:** Need to add prompt section to `simplePlanPrompt()` and `generateClaudeCodeSimplePlanningPrompt()`
   - **If no:** Should flag be ignored or error out when combined with `--simple`?
   - **Recommendation:** Support in both modes with appropriately simplified prompt for simple mode

5. **Existing Plan Generation:** Can the flag be used when updating existing plans (not just creating new ones)?
   - Current generate command supports updating existing plans with new tasks
   - Should blocking subissues be detected during updates as well?
   - **Recommendation:** Yes, support for updates makes sense for iterative planning

6. **Automated Tests:** Given the complexity of mocking LLM responses, should we:
   - **Option A:** Test with mocked LLM responses containing blocking subissues?
   - **Option B:** Test the parsing logic separately from the full command flow?
   - **Option C:** Both unit tests (parsing) and integration tests (full flow)?
   - **Recommendation:** Option C for comprehensive coverage

7. **Error Handling:** What should happen if:
   - Parent plan ID provided but doesn't exist?
   - Circular dependency would be created?
   - LLM response doesn't match expected format?
   - User cancels after some subissues already created?
   - **Need to decide:** Should partial creation be rolled back or left as-is?

8. **Priority Inheritance:** Should blocking subissues inherit priority from the main plan or allow LLM to suggest different priorities?
   - **Recommendation:** Allow LLM to suggest, but provide option to override all to match main plan priority

# Implementation Notes

Implemented tasks 1, 2, 3, 6, 9, 10, and 11: Add --with-blocking-subissues CLI flag; Update multi-phase prompt generation; Update simple mode prompt generation; Add tests for prompt generation; Snapshot plan IDs before LLM invocation; Add rmplan add instructions to prompts; Detect and report newly created plans. Introduced the new flag in src/rmplan/rmplan.ts and enforced Claude-mode-only execution inside src/rmplan/commands/generate.ts. Updated prompt builders in src/rmplan/prompt.ts to accept option objects, inject the Blocking Subissues guidance, and remind the agent to summarize blockers. Wired the withBlockingSubissues option through the CLI flow by snapshotting plan IDs, propagating prompt options, and logging newly created blocking plans after invokeClaudeCodeForGeneration, including warnings for unrelated plans. Extended MCP entry points in src/rmplan/mcp/generate_mode.ts to forward the new flag, register prompt arguments, and parse boolean values robustly. Added coverage in src/rmplan/commands/generate.test.ts to confirm that both planning prompt variants emit the blocking instructions. These changes ensure agents receive explicit rmplan add guidance for blockers while the CLI automatically detects and reports any subplans created during generation.

Restored MCP task parameter exports and relaxed the blocking-subissue flag guard. Specifically, I reintroduced exported Zod schemas for addPlanTaskParameters and removePlanTaskParameters in src/rmplan/mcp/generate_mode.ts, deriving the internal argument types from those schemas so the task-management integration tests can continue to parse tool inputs without duplication. The remove schema now enforces that callers provide either taskTitle or taskIndex while leaving normalization to the existing helpers. I also replaced the hard error in src/rmplan/commands/generate.ts with a warning when --with-blocking-subissues is used outside Claude mode; this keeps the enhanced prompt path available for direct and clipboard workflows while making it clear that automatic blocker detection still depends on Claude automation. Tasks addressed: restore MCP exports for task management tools; allow --with-blocking-subissues in non-Claude flows.
