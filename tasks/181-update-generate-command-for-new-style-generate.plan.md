---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: update generate command for new-style generate
goal: ""
id: 181
uuid: 33bdf7a9-7a21-4d7b-8dab-eac0aef0f6f0
generatedBy: agent
status: done
priority: medium
dependencies:
  - 178
  - 182
references:
  "178": 8970382a-14d8-40e2-9fda-206b952d2591
  "182": 3117183c-8d14-46bd-b4bd-2c4865522c32
planGeneratedAt: 2026-02-15T06:57:47.571Z
promptsGeneratedAt: 2026-02-15T06:57:47.571Z
createdAt: 2026-02-13T06:48:51.912Z
updatedAt: 2026-02-15T08:32:27.430Z
tasks:
  - title: Extract shared workspace setup helper into
      src/tim/workspace/workspace_setup.ts
    done: true
    description: "Create a new file src/tim/workspace/workspace_setup.ts that
      encapsulates the full workspace setup flow currently in agent.ts lines
      303-461. The function should accept WorkspaceSetupOptions (workspace,
      autoWorkspace, newWorkspace, nonInteractive, requireWorkspace),
      currentBaseDir, currentPlanFile, config, and commandLabel. It should
      return WorkspaceSetupResult with baseDir, planFile, workspaceTaskId, and
      isNewWorkspace. Handle: auto-workspace via
      WorkspaceAutoSelector.selectWorkspace(), manual workspace via
      findWorkspaceInfosByTaskId() with lock checks, workspace creation via
      createWorkspace(), git status validation, plan file copying to workspace,
      lock acquisition for existing workspaces (new ones already locked),
      cleanup handler setup via WorkspaceLock.setupCleanupHandlers(), fallback
      to current dir when workspace fails and !requireWorkspace, and the
      no-workspace-options case that locks currentBaseDir. Include
      sendStructured() workspace info emission. Write tests for the helper
      covering auto-workspace, manual workspace, lock acquisition, plan file
      copying, and fallback behavior."
  - title: Refactor agent command to use shared workspace setup helper
    done: true
    description: In src/tim/commands/agent/agent.ts, replace the workspace setup
      code (lines 303-461) with a call to the shared setupWorkspace() helper
      from src/tim/workspace/workspace_setup.ts. Also replace the cwd lock
      acquisition code (lines 449-461) since the helper handles both cases.
      Preserve any agent-specific post-setup logic (like sendStructured() if not
      in the helper). Run bun test to verify no regressions in the agent command
      behavior.
  - title: Simplify generate command - remove non-Claude modes, switch to
      interactive prompt, add workspace support
    done: true
    description: >-
      Major rewrite of src/tim/commands/generate.ts:


      1. Switch prompt: Replace generateSinglePromptForCLI() call with
      buildPromptText('generate-plan', { plan, allowMultiplePlans }, context)
      from src/tim/commands/prompts.ts. Build GenerateModeRegistrationContext
      with { config, configPath, gitRoot }.


      2. Remove plan sources: --plan-editor handling, --issue handling, and
      createStubPlanFromText function. Only keep positional arg, --plan,
      --latest, --next-ready.


      3. Remove non-Claude paths: clipboard/rmfilter mode, direct LLM mode,
      paste mode, extractMarkdownToYaml path,
      effectiveDirectMode/effectiveClaudeMode computation, rmfilter/rmpr option
      handling, temp file management.


      4. Remove post-execution blocking subissues scan (lines 797-856) and
      --with-blocking-subissues flag.


      5. Add workspace handling: Call setupWorkspace() helper after plan
      resolution. Update planFile and currentBaseDir from result.


      6. Update executor configuration: Use currentBaseDir (workspace-aware) as
      baseDir. Add terminalInput and noninteractive options computed same as
      agent command.


      7. Update auto-claim to use currentBaseDir for cwdForIdentity.


      8. Clean up all unused imports and dead code: clipboard,
      sshAwarePasteAction, waitForEnter, findFilesCore, RmfindOptions,
      argsFromRmprOptions, RmprOptions, createModel, runStreamingPrompt,
      extractMarkdownToYaml, findYamlStart, ExtractMarkdownToYamlOptions,
      planPrompt, simplePlanPrompt, generateSinglePromptForCLI, getIssueTracker,
      getInstructionsFromIssue, IssueInstructionData, isURL, etc.


      9. Keep: --commit, --simple, --executor, --next-ready, --latest, --plan,
      and the generateTaskCreationFollowUpPrompt follow-up.


      Run bun run check to verify no type errors.
  - title: Update CLI registration in tim.ts for generate command
    done: true
    description: >-
      In src/tim/tim.ts, update the generate command registration (lines
      278-315):


      Remove options: --plan-editor, --issue, --autofind, --quiet, --no-extract,
      --use-yaml, --direct/--no-direct, --claude/--no-claude.


      Add options (matching createAgentCommand() patterns at lines 562-576):
      --workspace <id>, --auto-workspace, --new-workspace, --non-interactive,
      --require-workspace (default false), --no-terminal-input.


      Keep options: --plan, --latest, --simple, --commit, -x/--executor,
      --next-ready.


      Update the command description to reflect the simplified behavior.
  - title: Add tests for simplified generate command with workspace support
    done: true
    description: >-
      Write integration tests verifying the simplified generate command works
      correctly:

      1. Verify the command resolves plans correctly (by ID, by path, --latest,
      --next-ready)

      2. Verify workspace options are properly passed through to setupWorkspace
      helper

      3. Verify terminal input options are computed correctly (enabled by
      default, disabled with --non-interactive or --no-terminal-input)

      4. Verify auto-claim uses workspace-aware cwdForIdentity

      5. Verify the prompt is generated via buildPromptText (same as tim prompts
      generate-plan)

      6. Verify removed options are no longer accepted


      Follow existing test patterns from agent command tests and
      task-management.integration.test.ts. Run bun test to ensure all tests
      pass.
  - title: "Address Review Feedback: `--new-workspace --workspace <id>` does not
      force new workspace creation if an unlocked matching workspace already
      exists."
    done: true
    description: >-
      `--new-workspace --workspace <id>` does not force new workspace creation
      if an unlocked matching workspace already exists. The code reuses the
      existing workspace first, so the force-new contract is not honored.


      Suggestion: Prioritize `options.newWorkspace === true` before reuse checks
      in manual workspace mode, so a new workspace is always created when
      explicitly requested.


      Related file: src/tim/workspace/workspace_setup.ts:78-99
  - title: "Address Review Feedback: `--workspace <id>` does not create a workspace
      when none exists."
    done: true
    description: >-
      `--workspace <id>` does not create a workspace when none exists. The
      implementation throws unless `--new-workspace` is also set, which
      contradicts the required create/reuse behavior and the CLI help text.


      Suggestion: When `options.workspace` is provided and no existing workspace
      is found, create a workspace by default. Reserve `--new-workspace` for
      force-new semantics when matching workspaces already exist.


      Related file: src/tim/workspace/workspace_setup.ts:104-111
  - title: "Address Review Feedback: Workspace lock acquisition failures are
      swallowed and execution continues unlocked."
    done: true
    description: >-
      Workspace lock acquisition failures are swallowed and execution continues
      unlocked. This violates the lock-before-execution invariant and allows
      concurrent runs in the same workspace/cwd.


      Suggestion: Treat lock acquisition failure as fatal (throw) for both
      workspace and fallback cwd lock paths. Only continue when lock is
      successfully acquired.


      Related file: src/tim/workspace/workspace_setup.ts:163-174
  - title: "Address Review Feedback: Tests currently encode/permit incorrect
      workspace semantics: they assert throwing when `--workspace` is missing an
      existing workspace instead of validating create/reuse behavior, and there
      is no test proving force-new behavior with `--new-workspace` when an
      unlocked workspace exists."
    done: true
    description: >-
      Tests currently encode/permit incorrect workspace semantics: they assert
      throwing when `--workspace` is missing an existing workspace instead of
      validating create/reuse behavior, and there is no test proving force-new
      behavior with `--new-workspace` when an unlocked workspace exists.


      Suggestion: Update tests to enforce required behavior: (1) `--workspace`
      creates when missing, (2) `--new-workspace --workspace` always creates new
      even if reusable workspace exists, and (3) lock acquisition failure aborts
      execution.


      Related file: src/tim/workspace/workspace_setup.test.ts:379-390
  - title: "Address Review Feedback: In the manual workspace selection path
      (`workspace_setup.ts:80-86`), when a stale lock is detected on a
      workspace, the code selects the workspace as 'available' but doesn't clear
      the stale lock from the database."
    done: true
    description: >-
      In the manual workspace selection path (`workspace_setup.ts:80-86`), when
      a stale lock is detected on a workspace, the code selects the workspace as
      'available' but doesn't clear the stale lock from the database. This can
      cause the subsequent `acquireLock` call at line 165 to fail because the
      stale lock data still exists. The `WorkspaceAutoSelector` properly handles
      stale lock clearing, but this manual path does not.


      Suggestion: Add `await WorkspaceLock.clearStaleLock(ws.workspacePath)`
      before setting `availableWorkspace = ws` when a stale lock is detected.
      This matches the behavior of the auto-workspace selector.


      Related file: src/tim/workspace/workspace_setup.ts:80-86
  - title: "Address Review Feedback: `stringifyPlanWithFrontmatter` is imported from
      `../../testing.js` but never used in the test file."
    done: true
    description: >-
      `stringifyPlanWithFrontmatter` is imported from `../../testing.js` but
      never used in the test file. This is leftover from the simplification that
      removed test cases that used it.


      Suggestion: Remove `stringifyPlanWithFrontmatter` from the import
      statement.


      Related file: src/tim/commands/generate.test.ts:12
  - title: "Address Review Feedback: Cleanup handlers for signal-based lock release
      (SIGINT/SIGTERM/SIGHUP) are only set up for existing (non-new)
      workspaces."
    done: true
    description: >-
      Cleanup handlers for signal-based lock release (SIGINT/SIGTERM/SIGHUP) are
      only set up for existing (non-new) workspaces. For new workspaces,
      `setupCleanupHandlers` is never called because the code assumes
      `createWorkspace()` handles locking. While the lock may be acquired, the
      signal handlers that release the lock on interruption are missing. If the
      process is killed during execution in a new workspace, the lock won't be
      released.


      Suggestion: Call `WorkspaceLock.setupCleanupHandlers(workspace.path,
      'pid')` unconditionally for all workspace paths (both new and existing),
      and only skip the `acquireLock` call for new workspaces.


      Related file: src/tim/workspace/workspace_setup.ts:163
changedFiles:
  - CLAUDE.md
  - README.md
  - claude-plugin/skills/using-tim/references/cli-commands.md
  - docs/linear-integration.md
  - docs/next-ready-feature.md
  - src/tim/commands/agent/agent.integration.test.ts
  - src/tim/commands/agent/agent.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/agent/agent.workspace_description.test.ts
  - src/tim/commands/generate.auto_claim.integration.test.ts
  - src/tim/commands/generate.test.ts
  - src/tim/commands/generate.ts
  - src/tim/tim.ts
  - src/tim/workspace/workspace_setup.test.ts
  - src/tim/workspace/workspace_setup.ts
tags: []
---

We want to update the `tim generate` command to run the new generate prompt that works interactively.

Like the `agent` command, running this command should lock the workspace and assign the plan to the workspace in which it is run. We should support
the various workspace selection options from `agent` as well.

## Research

### Overview

The `tim generate` command currently supports two primary modes: a traditional clipboard/rmfilter mode and a Claude Code executor-based mode (`--claude`, which is now the default). When running in Claude mode, it spawns a Claude Code subprocess with a single prompt that instructs the agent to explore the codebase, write research and implementation guide to the plan file, and add tasks using `tim tools update-plan-tasks`.

The `tim agent` command already implements comprehensive workspace management: workspace selection (manual or auto), workspace locking via `WorkspaceLock`, plan file copying into the workspace, cleanup handlers for lock release, and auto-claiming plans. Plan 181 requires bringing these same capabilities to the `generate` command.

### Key Files and Their Roles

**Generate command:**
- `src/tim/commands/generate.ts` - The main generate command handler (~960 lines). The Claude mode execution path is at lines 725-868: it builds a `singlePrompt` via `generateSinglePromptForCLI()`, creates an executor with `buildExecutorAndLog()`, calls `executor.execute()` with `executionMode: 'planning'`, then checks for tasks and optionally runs a follow-up prompt. Auto-claim happens at lines 858-868.

**CLI registration:**
- `src/tim/tim.ts` lines 278-315 - Generate command CLI registration. Currently has no workspace-related options. The agent command registration uses `createAgentCommand()` helper (lines 531-607) which adds workspace options.

**Agent command (reference implementation):**
- `src/tim/commands/agent/agent.ts` lines 267-461 - The `timAgent()` function implements the workspace handling flow:
  1. Lines 303-447: Workspace creation/selection logic with `--workspace`, `--auto-workspace`, and `--new-workspace` flags
  2. Lines 308-336: Auto-workspace path using `WorkspaceAutoSelector`
  3. Lines 337-377: Manual workspace path checking existing workspaces, lock status, creating new ones
  4. Lines 380-447: Workspace validation (git status), plan file copying, lock acquisition for existing workspaces
  5. Lines 449-461: Lock acquisition for the default case (no explicit workspace, locks current dir)
  6. Lines 544-558: Auto-claim plan after reading plan data

**Workspace infrastructure:**
- `src/tim/workspace/workspace_lock.ts` - `WorkspaceLock` class with static methods: `acquireLock()`, `releaseLock()`, `setupCleanupHandlers()`, `getLockInfo()`, `isLockStale()`, `clearStaleLock()`
- `src/tim/workspace/workspace_auto_selector.ts` - `WorkspaceAutoSelector` class with `selectWorkspace()` method
- `src/tim/workspace/workspace_manager.ts` - `createWorkspace()` function
- `src/tim/workspace/workspace_info.ts` - `findWorkspaceInfosByTaskId()`, `getWorkspaceInfoByPath()`, `patchWorkspaceInfo()`

**Executor infrastructure:**
- `src/tim/executors/index.ts` - `buildExecutorAndLog()`, `DEFAULT_EXECUTOR`
- `src/tim/executors/types.ts` - `Executor` interface, `ExecutorCommonOptions`, `ExecutePlanInfo`
- `src/tim/executors/claude_code/claude_code.ts` - The Claude Code executor, key options include `baseDir`, `terminalInput`, `noninteractive`

**Auto-claim:**
- `src/tim/assignments/auto_claim.ts` - `autoClaimPlan()`, `isAutoClaimEnabled()`
- `src/tim/assignments/uuid_lookup.ts` - `resolvePlanWithUuid()`

### Current Generate Command Claude Mode Flow

1. Plan source resolution (planArg, --plan, --issue, --plan-editor, --next-ready, --latest)
2. Stub plan creation if needed (from text, issue, or editor)
3. Build plan context via `buildPlanContext()`
4. Generate single prompt via `generateSinglePromptForCLI()` - a one-shot prompt that does everything without interactive collaboration
5. Build executor with `buildExecutorAndLog()` using `config.defaultExecutor`
6. Execute prompt with `executionMode: 'planning'`
7. Check if tasks were created; if not, run follow-up prompt
8. Check for blocking subissues if enabled
9. Auto-claim plan if enabled
10. Return (no extract step needed)

### Prompt System: Two Approaches

**Current (`generateSinglePromptForCLI` from `prompt.ts`)**: A self-contained one-shot prompt. It instructs the agent to explore, write research, and add tasks all in one go. Does NOT include interactive Q&A with the user.

**New (`loadResearchPrompt` / `buildPromptText('generate-plan', ...)` from `generate_mode.ts` / `prompts.ts`)**: The same prompt used by `tim prompts generate-plan`. This prompt includes interactive collaboration - it instructs the agent to explore, write research, then "collaborate with your human partner to refine this plan" by asking questions before finally adding tasks. This is the prompt we want to use because it enables interactive refinement via terminal input.

Key differences:
- `loadResearchPrompt` uses `buildPlanContext()` internally (takes plan ID, resolves it)
- `generateSinglePromptForCLI` takes pre-built plan text/context as input
- `loadResearchPrompt` handles `simple` mode by delegating to `loadGeneratePrompt`
- Both support `allowMultiplePlans` for breaking large scopes into child plans
- `loadResearchPrompt` returns a `{ messages: [...] }` structure; we need to extract the text via `buildPromptText()` / `extractPromptText()`

### What Needs to Change

The generate command needs workspace handling inserted **before** the executor runs (step 5-6 above), and lock cleanup **after** execution completes. The key changes:

1. **Add CLI options** for `--workspace`, `--auto-workspace`, `--new-workspace`, `--non-interactive`, `--require-workspace`, and `--no-terminal-input` to the generate command registration in `tim.ts`
2. **Add workspace handling logic** in `generate.ts` before the executor runs - mirroring the agent's workspace flow
3. **Pass workspace-aware `baseDir`** to the executor (currently uses `gitRoot`, should use workspace path when in a workspace)
4. **Enable terminal input** for the executor so the user can interact with Claude during generation
5. **Add workspace lock acquisition and cleanup** with proper error handling
6. **Move auto-claim earlier** (after workspace setup, not after execution) to match agent's pattern

### Patterns to Follow

- The agent command uses `WorkspaceLock.setupCleanupHandlers()` to register SIGINT/SIGTERM/SIGHUP handlers that release the lock
- New workspaces created by `createWorkspace()` or `WorkspaceAutoSelector` already hold a lock, so lock acquisition is skipped for new workspaces
- Plan files are copied into the workspace directory so the executor operates on a local copy
- The agent uses `sendStructured()` to emit workspace info for logging/monitoring
- The agent validates workspace git status after selection

### Existing Terminal Input Support

The executor already supports terminal input through `ExecutorCommonOptions.terminalInput`. The agent command computes this at lines 514-518:
```typescript
const terminalInputEnabled =
  !noninteractive &&
  process.stdin.isTTY === true &&
  options.terminalInput !== false &&
  config.terminalInput !== false;
```

The generate command currently does NOT pass `terminalInput` to the executor. Adding it will enable the interactive experience.

### Potential Challenges

1. **Plan file path management**: When a workspace is used, the plan file needs to be copied into the workspace and the `planFile` variable updated to the workspace-local copy. The generate command builds `planContext` from the stub plan before workspace setup, so the ordering of operations needs care.
2. **Cleanup on error**: The generate command uses a `try/finally` block at the end to clean up temp files. Lock cleanup should be integrated with this.
3. **Non-Claude modes**: Workspace locking should probably only apply when in Claude mode, since traditional clipboard mode doesn't hold long-running processes.
4. **The `baseDir` for executor**: Currently the generate command passes `gitRoot` as `baseDir`. In workspace mode, this needs to be the workspace path, but `gitRoot` is still needed for some pre-execution steps like `buildPlanContext`.

## Implementation Guide

### Expected Behavior

The `tim generate` command is significantly simplified to Claude-mode-only, uses the interactive prompt, and gains workspace management:
- Non-Claude modes (clipboard, direct, rmfilter) are removed entirely
- Plan sources simplified to: positional arg, `--plan`, `--latest`, `--next-ready` (removed `--plan-editor`, `--issue`)
- Stub plan creation from raw text/issue/editor is removed - the command only operates on existing plans
- Uses `buildPromptText('generate-plan', ...)` (same as `tim prompts generate-plan`) for interactive Q&A-based planning
- Removed CLI options: `--use-yaml`, `--direct`/`--no-direct`, `--claude`/`--no-claude`, `--autofind`, `--quiet`, `--extract`/`--no-extract`, `--plan-editor`, `--issue`
- Removed post-execution logic: `--with-blocking-subissues` post-check scan (the prompt handles this interactively)
- Kept CLI options: `--simple`, `--commit`, `--executor`, `--next-ready`, `--latest`, `--plan`
- New CLI options: `--workspace`, `--auto-workspace`, `--new-workspace`, `--non-interactive`, `--require-workspace`, `--no-terminal-input`
- Workspace locking: always acquires a lock (on workspace dir or cwd), released on exit/signal
- Terminal input is enabled by default when running interactively
- Dead code, unused imports, and `createStubPlanFromText` are cleaned up

### Acceptance Criteria

- [ ] `tim generate <plan>` runs Claude executor with terminal input enabled, locks cwd
- [ ] `tim generate <plan> --workspace <id>` creates/reuses a workspace, locks it, and runs generation there
- [ ] `tim generate <plan> --auto-workspace` auto-selects or creates a workspace
- [ ] `tim generate <plan> --new-workspace --workspace <id>` forces new workspace creation
- [ ] `tim generate <plan> --non-interactive` skips interactive prompts during workspace selection
- [ ] `tim generate <plan> --require-workspace` fails if workspace creation fails
- [ ] `--no-terminal-input` disables terminal input forwarding
- [ ] Workspace lock is acquired before execution and released on exit (via cleanup handlers)
- [ ] Plan file is copied into workspace when using workspace mode
- [ ] Auto-claim uses workspace-aware `cwdForIdentity`
- [ ] Non-Claude options (--direct, --no-direct, --claude, --no-claude, --autofind, --quiet, --use-yaml, --extract/--no-extract, --plan-editor) are removed
- [ ] Unused imports and dead code paths are cleaned up
- [ ] `--commit` option is preserved
- [ ] Generate command uses `loadResearchPrompt` / `buildPromptText('generate-plan', ...)` instead of `generateSinglePromptForCLI`
- [ ] Interactive Q&A collaboration works via terminal input during plan generation
- [ ] Shared workspace setup helper extracted and used by both generate and agent commands
- [ ] Agent command refactored to use the shared workspace setup helper

### Key Findings

**Product & User Story**: The generate command becomes a focused, interactive planning tool that always uses Claude Code. Users get workspace isolation, locking, and terminal input for interactive refinement. This aligns the generate command with the agent command's proven workspace management pattern.

**Design & UX Approach**: The command becomes simpler with fewer options. Users who previously used clipboard/direct modes will need to adapt, but Claude mode has been the default since it was added.

**Technical Plan & Risks**:
- Main risk: The shared workspace helper needs to handle both agent's and generate's slightly different workspace needs (agent has `sendStructured()` calls, does git validation, etc.)
- The generate command's variable flow (`planFile` gets reassigned multiple times) requires careful ordering of workspace setup relative to plan resolution
- Removing non-Claude modes simplifies the code significantly but is a breaking change for users of `--direct` or clipboard mode

**Pragmatic Effort Estimate**: Medium-sized change. The workspace helper extraction is the bulk of the work. The generate simplification is mostly deletion. Testing should be straightforward.

### Step 1: Extract Shared Workspace Setup Helper

Create `src/tim/workspace/workspace_setup.ts` with a function that encapsulates the full workspace setup flow from `agent.ts` lines 303-461.

**Interface design:**
```typescript
interface WorkspaceSetupOptions {
  workspace?: string;        // Task ID for workspace
  autoWorkspace?: boolean;   // Auto-select/create
  newWorkspace?: boolean;    // Force new workspace
  nonInteractive?: boolean;  // Skip interactive prompts
  requireWorkspace?: boolean; // Fail if workspace creation fails
}

interface WorkspaceSetupResult {
  baseDir: string;           // Updated base directory (workspace path or original)
  planFile: string;          // Updated plan file path (workspace-local or original)
  workspaceTaskId?: string;  // Task ID if workspace was used
  isNewWorkspace?: boolean;  // Whether workspace was newly created
}

async function setupWorkspace(
  options: WorkspaceSetupOptions,
  currentBaseDir: string,
  currentPlanFile: string,
  config: EffectiveConfig,
  commandLabel: string       // e.g., 'tim generate' or 'tim agent' for lock command string
): Promise<WorkspaceSetupResult>
```

The function should:
1. Handle `--auto-workspace` path: use `WorkspaceAutoSelector.selectWorkspace()`
2. Handle manual `--workspace` path: check existing workspaces via `findWorkspaceInfosByTaskId()`, check lock status, create new if `--new-workspace`
3. Validate workspace git status
4. Copy plan file to workspace
5. Acquire lock for existing workspaces (new ones are already locked)
6. Set up cleanup handlers via `WorkspaceLock.setupCleanupHandlers()`
7. Handle the "no workspace options" case: acquire lock on `currentBaseDir`
8. If workspace creation fails and `!requireWorkspace`, fall back to current dir

Reference: `src/tim/commands/agent/agent.ts` lines 303-461 for the exact logic to extract.

### Step 2: Refactor Agent Command to Use Shared Helper

In `src/tim/commands/agent/agent.ts`, replace the workspace setup code (lines 303-461) with a call to the shared `setupWorkspace()` helper.

This validates that the helper correctly handles all the agent's workspace scenarios. The `sendStructured()` call can either be included in the helper or called after setup in the agent command.

Make sure to run `bun test` after this refactoring to verify no regressions.

### Step 3: Simplify Generate Command - Remove Non-Claude Modes and Switch Prompt

In `src/tim/commands/generate.ts`, make two major changes:

**A. Switch to `loadResearchPrompt` / `buildPromptText`**

Replace the `generateSinglePromptForCLI()` call with `buildPromptText('generate-plan', { plan: planFileOrId, allowMultiplePlans: true }, context)` from `src/tim/commands/prompts.ts`. This produces the same prompt as `tim prompts generate-plan`, which includes interactive Q&A collaboration.

The `buildPromptText` function:
- Takes a prompt name (`'generate-plan'`), args (`{ plan, allowMultiplePlans }`), and a `GenerateModeRegistrationContext`
- Internally calls `loadResearchPrompt()` which resolves the plan, builds context, and generates the full prompt
- Returns a string (extracts text from the message structure)
- Handles `simple` mode automatically (delegates to `loadGeneratePrompt` when `plan.simple === true`)

The `GenerateModeRegistrationContext` needs `{ config, configPath, gitRoot }` - all of which are already available in the generate command.

This replaces the current flow of manually building plan context and calling `generateSinglePromptForCLI()`.

The `generateTaskCreationFollowUpPrompt` follow-up can be kept for now since it may still be useful if tasks aren't created.

**B. Remove non-Claude execution paths and simplified plan sources**

1. **Removed plan sources**: `--plan-editor` handling (lines 392-432), `--issue` handling (lines 433-452)
2. **Removed stub plan creation**: `createStubPlanFromText` function and all related logic. The command now only operates on existing plan files.
3. **Removed modes**: All non-Claude execution paths:
   - Traditional clipboard/rmfilter mode (lines 583-717)
   - Direct LLM mode (lines 872-895)
   - Original clipboard/paste mode (lines 896-905)
   - The `extractMarkdownToYaml` code path (lines 906-942)
4. **Removed post-execution logic**: The `--with-blocking-subissues` post-check scan (lines 797-856) that scanned for newly created plans. The prompt already instructs the agent to handle blocking subissues interactively.
5. **Removed options processing**:
   - `effectiveDirectMode` computation
   - `effectiveClaudeMode` computation (always true now)
   - rmfilter/rmpr option handling
   - `tmpPromptPath`, `rmfilterOutputPath` temp file management
   - Issue tracking / `getInstructionsFromIssue` / `issueResult` handling
6. **Unused imports**: Remove imports for `clipboard`, `sshAwarePasteAction`, `waitForEnter`, `findFilesCore`, `RmfindOptions`, `argsFromRmprOptions`, `RmprOptions`, `createModel`, `runStreamingPrompt`, `extractMarkdownToYaml`, `findYamlStart`, `ExtractMarkdownToYamlOptions`, `planPrompt`, `simplePlanPrompt`, `generateSinglePromptForCLI`, `getIssueTracker`, `getInstructionsFromIssue`, `IssueInstructionData`, `isURL`, and any others that become unused.

### Step 4: Update CLI Registration in `tim.ts`

In `src/tim/tim.ts`, update the generate command registration:

**Remove options:**
- `--plan-editor`
- `--issue <url|number>`
- `--autofind`
- `--quiet`
- `--no-extract`
- `--use-yaml <yaml_file>`
- `--direct` / `--no-direct`
- `--claude` / `--no-claude`

**Add options** (matching `createAgentCommand()` patterns at lines 562-576):
- `--workspace <id>` with description matching agent's
- `--auto-workspace`
- `--new-workspace`
- `--non-interactive`
- `--require-workspace` (default false)
- `--no-terminal-input`

**Keep options:**
- `--plan <plan>`
- `--latest`
- `--simple`
- `--commit`
- `-x, --executor <name>`
- `--with-blocking-subissues`
- `--next-ready <planIdOrPath>`

### Step 5: Add Workspace Handling and Update Executor Configuration

In `handleGenerateCommand`, after plan source resolution and stub plan setup, add workspace handling:

1. Get `currentBaseDir` via `getGitRoot()`
2. Call shared `setupWorkspace()` helper with the options
3. Update `planFile` and `currentBaseDir` from the result
4. Build the prompt using `buildPromptText('generate-plan', { plan: planFileOrId, allowMultiplePlans }, context)`
5. Compute `terminalInput` and `noninteractive` for executor options

The executor options should become:
```typescript
const noninteractive = options.nonInteractive === true;
const terminalInputEnabled =
  !noninteractive &&
  process.stdin.isTTY === true &&
  options.terminalInput !== false &&
  config.terminalInput !== false;

const sharedExecutorOptions: ExecutorCommonOptions = {
  baseDir: currentBaseDir,
  model: config.models?.stepGeneration,
  noninteractive: noninteractive ? true : undefined,
  terminalInput: terminalInputEnabled,
};
```

Auto-claim should use `currentBaseDir` for `cwdForIdentity`:
```typescript
await autoClaimPlan({ plan, uuid }, { cwdForIdentity: currentBaseDir });
```

### Step 6: Clean Up Dead Code

After removing non-Claude modes, audit `generate.ts` for:
- Unused variables and imports
- Dead code paths that were only reachable from removed modes
- The temp file cleanup in the `finally` block (may be simplified since rmfilter temp files are no longer created)
- `allRmfilterOptions` variable and related rmfilter option processing - these are no longer needed since we're using `buildPromptText` which handles plan context internally

Run `bun run check` to verify no type errors from the cleanup.

### Step 7: Add Tests

Write tests for:
1. The shared workspace setup helper - test auto-workspace, manual workspace, lock acquisition, plan file copying, fallback behavior
2. The simplified generate command - verify it works with workspace options
3. Verify agent command still works correctly after refactoring to use shared helper

Follow existing test patterns. The workspace setup helper tests should create temp directories and verify lock state.

### Manual Testing Steps

1. Run `tim generate <plan-id> --workspace test-ws --new-workspace` and verify workspace creation, plan copy, lock, execution, and cleanup
2. Run `tim generate <plan-id> --auto-workspace` and verify auto-selection works
3. Run `tim generate <plan-id>` without workspace flags and verify cwd locking
4. Run `tim agent <plan-id> --workspace test-ws --new-workspace` and verify agent still works with shared helper
5. Verify that removed options (`--direct`, `--claude`, `--plan-editor`, etc.) are no longer accepted

### Dependencies and Constraints

- **Dependencies**: Plans 178 (streaming JSON input) and 182 (terminal input) are both marked DONE
- **Breaking change**: Users of clipboard/direct modes will need to adapt. Claude mode has been the default.
- **Constraint**: The `createAgentCommand()` helper in `tim.ts` is specific to the agent command (registers `.action()` handler). Workspace CLI options are added directly to generate registration.

### Potential Gotchas

- **Variable scoping**: The generate command defines `planFile` as a `let` that gets reassigned multiple times. Workspace setup must happen after plan resolution but before executor creation.
- **Error handling in workspace creation**: If workspace creation fails but `--require-workspace` is not set, fall back to current directory. The shared helper should handle this.
- **Lock cleanup**: Use `WorkspaceLock.setupCleanupHandlers()` for signal-based cleanup, not the finally block. The lock needs to be released even if the process is interrupted.
- **rmfilter args in Claude mode**: Check whether `allRmfilterOptions` is still used in the Claude path. The current code collects rmfilter options even in Claude mode (lines 567-582). These may be passed to `planRmfilterArgs` for extract, but since we're removing extract, this may become dead code. Verify and clean up.
- **`sendStructured()` workspace info**: The agent command emits workspace info via `sendStructured()` for monitoring. Decide whether to include this in the shared helper or handle it per-command.

## Current Progress
### Current State
- All 12 tasks are complete. The generate command has been fully simplified, workspace support added, and all review feedback addressed.
### Completed (So Far)
- Extracted `setupWorkspace()` into `src/tim/workspace/workspace_setup.ts` with `WorkspaceSetupOptions`/`WorkspaceSetupResult` interfaces
- Refactored `src/tim/commands/agent/agent.ts` to use the shared helper (replaced ~160 lines of inline workspace logic)
- `sendStructured()` workspace info emission is included in the shared helper
- 17 tests in `src/tim/workspace/workspace_setup.test.ts` covering all paths including new semantics
- All agent tests (171 pass, 7 skip) continue to pass
- Simplified `generate.ts` from ~960 lines to ~267 lines by removing all non-Claude execution modes
- Switched to `buildPromptText('generate-plan', ...)` for the interactive prompt system
- Added workspace support via `setupWorkspace()` helper
- Added terminal input and noninteractive options
- Updated CLI registration in `tim.ts`: removed 8 old options, added 6 workspace options
- 28 generate tests pass (27 unit + 1 auto-claim integration)
- Review feedback tasks 6-12 all addressed:
  - `--new-workspace` now always forces new workspace creation before reuse checks
  - `--workspace <id>` auto-creates when no workspace exists (no `--new-workspace` needed)
  - Lock acquisition failures are now fatal (throw instead of warn)
  - Stale locks are cleared in the manual workspace path before reuse
  - Cleanup handlers registered for ALL workspaces (new + existing)
  - New workspaces get PID locks (persistent lock from createWorkspace is released and re-acquired as PID)
  - Removed unused `stringifyPlanWithFrontmatter` import from generate.test.ts
  - Updated agent test mocks to return valid `{ type: 'pid' }` from acquireLock
### Remaining
- None
### Next Iteration Guidance
- None needed - all tasks complete
### Decisions / Changes
- `sendStructured()` workspace info emission was included in the shared helper rather than per-command, since both agent and generate need it
- Error handling: explicit workspace selection errors (locked workspace, missing workspace without --new-workspace) propagate up as throws; only graceful null returns (workspace creation/selection returned null) trigger the fallback-to-cwd behavior
- Fallback path now acquires cwd lock before returning (was missing in initial implementation)
- `--new-workspace` + all-locked-workspaces now creates a new workspace instead of throwing misleading error
- Lock acquisition failures are now fatal (throw), ensuring the lock-before-execution invariant is maintained
- `--with-blocking-subissues` was removed from the generate CLI registration because `loadResearchPrompt` hardcodes `withBlockingSubissues: false` and doesn't accept it as a parameter. The prompt system would need extension to support this, which is out of scope.
- Auto-claim was moved to before executor execution (after workspace setup), matching the agent command's pattern
- `commitAll()` from `common/process.ts` is used for the `--commit` option, replacing the old `extractMarkdownToYaml` commit path
- `generate-plan-simple` prompt name is used when `--simple` flag is set or plan has `simple: true`
- `gitRoot` from `resolvePlanPathContext` is reused instead of calling `getGitRoot()` separately
- For new workspaces, `createWorkspace()` persistent lock is released and re-acquired as PID lock to enable signal-based cleanup
- `--workspace <id>` without `--new-workspace` now auto-creates when no existing workspace is found (reserve `--new-workspace` for force-new when workspaces already exist)
### Lessons Learned
- When extracting error-handling logic into a shared helper, blanket try-catch can change error semantics. Explicit throws that were previously unhandled can get caught by a new outer catch, silently converting hard errors into soft fallbacks. Solution: only catch specific expected failure modes (null returns), not all exceptions.
- The fallback path in workspace setup must still acquire a lock on cwd to maintain the invariant that execution always runs with a lock. Early returns can skip this.
- The `logSpawn()` function returns a Subprocess where `exitCode` may be null before the process finishes. Always `await subprocess.exited` before checking exitCode.
- When a CLI flag is "kept for the prompt" but the new prompt system doesn't support it, it's better to remove the flag than leave a no-op option that misleads users. Dead CLI options create confusion.
- Auto-claim timing matters: it should happen before execution (after workspace setup) so the plan is assigned even if the executor fails or is interrupted.
- When making lock acquisition fatal, all existing test mocks that previously returned void from acquireLock must be updated to return valid lock info objects. The change cascades to all callers.
- `createWorkspace()` acquires persistent locks, not PID locks. For signal-based cleanup to work, the lock must be released and re-acquired as PID. This is a hidden contract mismatch between workspace creation and workspace execution.
### Risks / Blockers
- None
