---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Ability to run a prompt in claude or codex in a workspace against a
  particular branch
goal: ""
id: 219
uuid: 9a638137-5cb4-46a0-9f13-bf129cd3efdb
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-03-20T23:30:46.768Z
promptsGeneratedAt: 2026-03-20T23:30:46.768Z
createdAt: 2026-03-07T07:43:56.083Z
updatedAt: 2026-03-21T09:12:54.402Z
tasks:
  - title: Refactor setupWorkspace to make plan file optional
    done: true
    description: "In src/tim/workspace/workspace_setup.ts, change the planFile
      parameter from required string to optional (string | undefined). Add
      guards so that plan file copy (lines 185-197) is skipped when no plan file
      is provided, branch derivation (lines 252-261) falls back gracefully when
      there is no plan data, and workspace description uses a generic value.
      This is a broader refactor that benefits all callers. Update all existing
      call sites (generate.ts, agent.ts) to pass the plan file as before — they
      should continue working identically. Also handle the case where no plan
      and no --base is specified: skip branch checkout entirely and use the
      workspace current branch as-is."
  - title: Add workspace CLI options to tim chat command registration
    done: true
    description: "In src/tim/tim.ts, find the chat command registration and add
      workspace-related options matching the patterns used by generate and
      agent: -w/--workspace <id>, --aw/--auto-workspace, --nw/--new-workspace,
      --base <ref>, --no-workspace-sync, --commit, --plan <plan>. Follow the
      exact same option definitions used by the generate command. Also update
      the ChatCommandOptions interface in src/tim/commands/chat.ts to include
      the new fields: workspace, autoWorkspace, newWorkspace, base,
      workspaceSync (boolean), commit, plan."
  - title: Implement workspace lifecycle in handleChatCommand
    done: true
    description: "Modify handleChatCommand in src/tim/commands/chat.ts to add the
      full workspace roundtrip when workspace options are provided. Follow
      generate.ts as the reference implementation. Key steps: (1) Detect
      workspace mode (any of workspace, autoWorkspace, newWorkspace, or plan is
      set). (2) If --plan is provided, resolve plan file via resolvePlanFile(),
      read plan data for branch/UUID/metadata. (3) Call setupWorkspace() with
      createBranch: false (we check out existing branches, not create new ones).
      Pass plan file and planUuid when available. (4) Call
      prepareWorkspaceRoundTrip() if workspace changed from original baseDir.
      (5) Run runPreExecutionWorkspaceSync() if syncTarget is not origin. (6)
      Set executor baseDir to workspace path. (7) Execute the prompt (existing
      logic). (8) If --commit, call commitAll(). (9) In finally block:
      runPostExecutionWorkspaceSync() with generic commit message like workspace
      chat session, touchWorkspaceInfo(), handle errors like generate.ts does
      (generation error + sync error). When --plan is provided, update workspace
      metadata from plan data and include plan info in headless adapter call."
  - title: Write tests for workspace-enabled chat
    done: true
    description: "Add tests in src/tim/commands/chat.test.ts (create if needed).
      Test: (1) When no workspace options are provided, behavior is unchanged —
      executor gets process.cwd() as baseDir. (2) When workspace options are
      provided, setupWorkspace is called with correct parameters. (3) When
      --plan is provided, plan is resolved and its data is used for workspace
      setup (UUID, branch). (4) When --base is provided without --plan,
      createBranch is false and the branch is checked out directly. (5) When
      --commit is set, commitAll is called after execution. (6) Workspace
      roundtrip functions are called in the correct order. (7) Cleanup runs even
      when execution fails. Focus on testing the integration points; the
      workspace setup functions themselves are already tested elsewhere. Use
      dependency injection patterns already established in the codebase (e.g.
      RunPromptCommandDeps pattern)."
  - title: Update README with workspace options for tim chat
    done: true
    description: "Update the README documentation for tim chat to describe the new
      workspace options. Document that workspace options (-w, --aw, --nw,
      --base, --plan, --commit, --no-workspace-sync) enable the full workspace
      roundtrip flow. Include examples: tim chat --aw --plan 42 Fix the bug, tim
      chat -w my-workspace --base feature-branch Review code, tim chat --aw
      --base main --commit Clean up imports. Note that without workspace
      options, chat works exactly as before."
changedFiles:
  - README.md
  - docs/implementer-instructions.md
  - src/tim/commands/chat.test.ts
  - src/tim/commands/chat.ts
  - src/tim/tim.ts
  - src/tim/workspace/workspace_auto_selector.ts
  - src/tim/workspace/workspace_manager.test.ts
  - src/tim/workspace/workspace_manager.ts
  - src/tim/workspace/workspace_setup.ts
tags: []
---

Run interactive by default but we should be able to run non-interactively. This should participate in the full workspace
roundtrip flow.

## Design Decisions

- **Command**: Enhance existing `tim chat` with workspace options (no new command)
- **Prompt type**: Arbitrary free-form prompts only (no named tim prompts)
- **Branch behavior**: `--base` checks out an existing branch as-is (no new branch creation)
- **Plan support**: `--plan` optionally associates the session with a plan (provides branch, UUID, workspace assignment)
- **Branch derivation**: When `--plan` is provided, branch is derived from plan data (same as generate/agent). `--base` overrides if specified.
- **No workspace + no plan + no base**: When workspace options are set but no plan or base, use the workspace's current branch as-is
- **Commit**: `--commit` is opt-in (default off), workspace roundtrip sync always runs in workspace mode (matching generate/agent)
- **Backward compatibility**: When no workspace options are provided, `tim chat` behaves identically to current behavior
- **setupWorkspace refactor**: Make plan file parameter optional in `setupWorkspace()` (option 1 — proper refactor)

## Research

### Problem Statement

Currently, the `tim chat` command runs arbitrary prompts against Claude Code or Codex CLI but has no workspace support — it always runs in `process.cwd()`. Meanwhile, `tim generate` and `tim agent` have full workspace roundtrip support (workspace selection/creation, locking, branch checkout, pre/post-execution sync) but are tightly coupled to plan-specific workflows. There is no way to run an arbitrary prompt or skill in a workspace against a specific branch with the full workspace lifecycle.

### Key Findings

#### Existing Command Landscape

1. **`tim chat`** (`src/tim/commands/chat.ts`):
   - Runs an arbitrary prompt via an executor in `'bare'` execution mode
   - Supports Claude Code and Codex CLI executors
   - Interactive by default (terminal input enabled, inactivity timeout disabled)
   - No workspace support — always uses `process.cwd()` as baseDir
   - No plan context — uses `planId: 'chat'`, `planTitle: 'Chat Session'`
   - No workspace roundtrip, no branch checkout, no locking

2. **`tim generate`** (`src/tim/commands/generate.ts`):
   - Full workspace roundtrip: `setupWorkspace()` → `prepareWorkspaceRoundTrip()` → pre-sync → execute → post-sync → cleanup
   - Tightly coupled to plan generation — always uses `'planning'` execution mode, always loads a plan-specific prompt
   - Has all the workspace CLI options: `-w`, `--aw`, `--nw`, `--base`, `--no-workspace-sync`

3. **`tim agent`** (`src/tim/commands/agent/agent.ts`):
   - Full workspace roundtrip with the same pattern as `generate`
   - Coupled to plan execution with task iteration loops
   - Most complex workspace lifecycle management

4. **`tim run-prompt`** (`src/tim/commands/run_prompt.ts`):
   - One-shot prompt execution with structured output capture
   - Non-interactive, runs `claude --print` or `codex exec --json`
   - No workspace support, no executor interface (spawns processes directly)

#### Workspace Roundtrip Flow (from `generate.ts` — the simplest example)

The full workspace roundtrip pattern consists of these steps:

```
1. setupWorkspace(options, baseDir, planFile, config, commandName)
   → Returns: { baseDir, planFile, workspaceTaskId, isNewWorkspace }

2. prepareWorkspaceRoundTrip({ workspacePath, workspaceSyncEnabled, syncTarget })
   → Only if workspace changed from original baseDir
   → Returns: WorkspaceRoundTripContext | null

3. runPreExecutionWorkspaceSync(roundTripContext)
   → Only if syncTarget !== 'origin'

4. [Execute prompt via executor]

5. runPostExecutionWorkspaceSync(roundTripContext, commitMessage)
   → Commits all changes, pushes to origin or primary workspace

6. touchWorkspaceInfo(workspacePath)
   → Updates workspace last-used timestamp
```

#### Workspace Setup Dependencies

`setupWorkspace()` (`src/tim/workspace/workspace_setup.ts`) currently requires:
- A plan file path (for copying into workspace)
- A config object
- A command name (for lock identification)

It optionally uses:
- `planUuid` for auto-workspace assignment
- Branch name derived from plan data (via `generateBranchNameFromPlan()`)

For our use case, the plan file is optional. The branch might be specified directly via CLI rather than derived from a plan. This means we need to handle the case where there's no plan but there is an explicit branch.

#### Branch Management in Workspaces

In `workspace_setup.ts` (lines 200-330), when reusing an existing workspace:
- Branch name comes from `planData.branch || generateBranchNameFromPlan(planData)`
- Base branch comes from `options.base || planData.baseBranch || parent plan's branch`
- Calls `prepareExistingWorkspace()` which fetches, checks out base, creates new branch

In `workspace_manager.ts`, `prepareExistingWorkspace()` accepts:
- `baseBranch`: branch to start from
- `branchName`: new branch to create
- `createBranch`: whether to create a new branch (defaults to true)

For this feature, we want to check out an **existing** branch, not create a new one. The `--base` option in workspace setup already supports specifying a branch, but it's used as a starting point for creating a new branch. We need a way to say "just check out this branch" without creating a new one.

#### Executor Interface

The `Executor.execute()` method signature:
```typescript
execute(
  contextContent: string | undefined,
  planInfo: ExecutePlanInfo
): Promise<void | ExecutorOutput>
```

`ExecutePlanInfo` requires `planId`, `planTitle`, `planFilePath`, and `executionMode`. For a workspace chat session, we can use placeholder values similar to `chat` (e.g., `planId: 'chat'`, `executionMode: 'bare'`).

#### Headless Adapter Integration

Both `generate` and `chat` wrap execution with `runWithHeadlessAdapterIfEnabled()` which:
- Creates a headless adapter for WebSocket communication
- Reports session info (command, plan, workspace path)
- Enables the web UI to track the session

For workspace chat, we should report the command and workspace path so sessions are correctly grouped in the web UI.

#### Prompt Input

`chat` already has prompt resolution via `resolveOptionalPromptText()`:
- Positional argument text
- `--prompt-file` to read from a file
- stdin when not a TTY

This should be reused as-is.

### Notable Files and Their Roles

| File | Role |
|------|------|
| `src/tim/commands/chat.ts` | Current chat command — base for this feature |
| `src/tim/workspace/workspace_setup.ts` | Workspace selection, creation, locking, branch checkout |
| `src/tim/workspace/workspace_roundtrip.ts` | Pre/post-execution sync between workspace and origin |
| `src/tim/workspace/workspace_manager.ts` | Low-level workspace creation and branch operations |
| `src/tim/workspace/workspace_info.ts` | Workspace metadata queries and updates |
| `src/tim/workspace/workspace_lock.ts` | Workspace locking (PID-based) |
| `src/tim/commands/generate.ts` | Reference implementation for workspace roundtrip in a command |
| `src/tim/executors/build.ts` | Executor factory — `buildExecutorAndLog()` |
| `src/tim/executors/types.ts` | `ExecutorCommonOptions`, `ExecutePlanInfo` interfaces |
| `src/tim/headless.ts` | `runWithHeadlessAdapterIfEnabled()` wrapper |
| `src/tim/tim.ts` | CLI registration for all commands |

### Architectural Considerations

1. **`setupWorkspace()` coupling to plan files**: The function expects a plan file path and uses it to copy the plan into the workspace and derive branch names. For workspace-chat without a plan, we need to either:
   - Pass empty/null plan file and handle gracefully
   - Refactor `setupWorkspace` to make plan file optional
   - Create a lighter-weight workspace setup for chat

2. **Branch checkout vs. branch creation**: The existing workspace setup always wants to create a new branch. We need to support checking out an existing branch without creating a new one. The `prepareExistingWorkspace()` function has a `createBranch` option that can be set to `false`, but the upstream code in `setupWorkspace()` always derives a branch name from plan data.

3. **Post-execution commit message**: `runPostExecutionWorkspaceSync()` takes a commit message string. For chat, we'll need a generic one like `"workspace chat session"`.

4. **Workspace without a plan**: The current flow updates workspace metadata (planId, planTitle, description, issueUrls) from plan data. Without a plan, we'd skip or use generic metadata.

## Implementation Guide

### Approach: Add Workspace Options to `tim chat`

The recommended approach is to enhance `tim chat` with the same workspace CLI options available in `generate` and `agent`. This avoids creating a new command and leverages the existing chat infrastructure.

When workspace options are provided, `chat` will follow the same workspace roundtrip lifecycle as `generate`:
1. Setup workspace → 2. Pre-sync → 3. Execute → 4. Post-sync → 5. Cleanup

When no workspace options are provided, `chat` continues to work exactly as it does today.

### Step 1: Add Workspace CLI Options to `tim chat`

In `src/tim/tim.ts`, find the `chat` command registration and add the workspace-related options that `generate` and `agent` already use:

- `-w, --workspace <id>` — explicit workspace ID
- `--aw, --auto-workspace` — auto-select/create workspace
- `--nw, --new-workspace` — force new workspace creation
- `--base <ref>` — base branch to check out (or branch to work on)
- `--no-workspace-sync` — disable workspace sync
- `--commit` — commit changes after execution
- `--plan <plan>` — optional plan to associate with the workspace session (provides branch name, workspace assignment)

Follow the exact same option patterns used by `generate` (see `tim.ts` for the `generate` command's options).

### Step 2: Update `ChatCommandOptions` Interface

In `src/tim/commands/chat.ts`, extend the `ChatCommandOptions` interface to include the new workspace-related fields:

```typescript
export interface ChatCommandOptions {
  executor?: string;
  model?: string;
  promptFile?: string;
  nonInteractive?: boolean;
  terminalInput?: boolean;
  headlessAdapter?: boolean;
  // New workspace options
  workspace?: string;
  autoWorkspace?: boolean;
  newWorkspace?: boolean;
  base?: string;
  workspaceSync?: boolean;
  commit?: boolean;
  plan?: string;
}
```

### Step 3: Implement Workspace Lifecycle in `handleChatCommand`

Modify `handleChatCommand` in `src/tim/commands/chat.ts` to follow the workspace roundtrip pattern from `generate.ts`. The key sections:

**a) Determine if workspace mode is active:**
Check if any workspace option is set (`workspace`, `autoWorkspace`, `newWorkspace`). If not, skip all workspace logic and run as today.

**b) Optional plan resolution:**
If `--plan` is specified, resolve the plan file to extract branch name, UUID, and metadata. This is optional — workspace mode can work without a plan (using `--base` directly for the branch).

**c) Workspace setup:**
Call `setupWorkspace()` with the appropriate options. For the plan file parameter, pass the resolved plan file or an empty string. The `createBranch` option should be `false` when using `--base` without a plan (we want to check out the existing branch, not create a new one).

Key consideration: `setupWorkspace()` uses `generateBranchNameFromPlan()` when a plan is provided. Without a plan, the branch comes from `--base`. We need to ensure `setupWorkspace()` handles the case where there's no plan file gracefully — the function already handles this by falling back to the original baseDir if workspace options aren't provided.

**d) Workspace roundtrip:**
Follow the generate pattern:
```
prepareWorkspaceRoundTrip() → runPreExecutionWorkspaceSync() → execute → runPostExecutionWorkspaceSync() → touchWorkspaceInfo()
```

**e) Post-execution:**
- If `--commit` is specified, commit all changes
- Run workspace sync
- Touch workspace info
- Clean up in finally block

### Step 4: Handle Plan-less Workspace Setup

The `setupWorkspace()` function in `src/tim/workspace/workspace_setup.ts` has some assumptions about plan data being available. Review and ensure these paths handle gracefully when:
- Plan file path is empty/undefined
- No branch name can be derived from plan data
- No planUuid for workspace assignment

The main areas to check:
- Plan file copy step (lines 185-197) — should skip if no plan file
- Branch derivation (lines 252-261) — should skip if no plan data, use `--base` directly
- Workspace description update — should use generic description

If `setupWorkspace()` already handles these cases (it checks for plan data before using it), minimal changes are needed. If not, add guards.

### Step 5: Support Direct Branch Checkout (No New Branch)

When the user specifies `--base` without a plan, the intent is to check out that branch directly, not create a new feature branch off it. This means:
- Pass `createBranch: false` to `setupWorkspace()`
- The workspace should check out the specified branch as-is
- The `--base` option serves as "the branch to work on" rather than "the branch to base a new branch on"

Verify that `prepareExistingWorkspace()` in `workspace_manager.ts` correctly handles `createBranch: false` — it should check out the base branch and stop there without creating a new branch.

### Step 6: Add the `--plan` Option for Plan-Aware Chat

When `--plan` is provided:
1. Resolve the plan file via `resolvePlanFile()`
2. Read plan data to extract branch, UUID, metadata
3. Pass plan UUID to `setupWorkspace()` for workspace assignment
4. Update workspace metadata from plan data (reuse `updateWorkspaceDescriptionFromPlan()` from generate)
5. Use plan info in headless adapter session info

This makes it possible to run an ad-hoc prompt in a workspace that's associated with a plan, which is useful for one-off tasks, debugging, or manual interventions in an ongoing plan's workspace.

### Step 7: Update Headless Adapter Integration

Update the `runWithHeadlessAdapterIfEnabled()` call to include workspace path and optional plan info:

```typescript
await runWithHeadlessAdapterIfEnabled({
  enabled: options.headlessAdapter === true || !tunnelActive,
  command: 'chat',
  interactive: true,
  config,
  plan: planData ? { id: planData.id, title: planData.title } : undefined,
  callback: async () => { ... },
});
```

This ensures the web UI correctly groups the session under the right workspace.

### Step 8: Write Tests

Add tests for the new workspace integration in chat:

1. **Unit tests** in `src/tim/commands/chat.test.ts` (or create it):
   - Verify that workspace options are correctly parsed and passed through
   - Verify that when no workspace options are provided, behavior is unchanged
   - Verify that `--plan` resolution works correctly

2. **Integration considerations**:
   - The workspace setup functions are already well-tested in existing test suites
   - Focus tests on the new integration points: option parsing, conditional workspace setup, commit behavior

### Step 9: Update README

Document the new workspace options for `tim chat` in the README, following the existing documentation patterns.

### Manual Testing Steps

1. `tim chat "Fix the bug" -w my-workspace --base feature-branch` — should set up workspace, check out branch, run prompt interactively
2. `tim chat --plan 42 --aw "Review the implementation"` — should auto-select workspace associated with plan 42, run prompt
3. `tim chat "Hello"` — should work exactly as before (no workspace)
4. `tim chat --non-interactive --plan 42 --aw "Run tests and report results"` — non-interactive with workspace
5. `tim chat -w my-workspace --base main --commit "Clean up unused imports"` — commit changes after execution

### Acceptance Criteria

- [ ] `tim chat` with workspace options (`-w`, `--aw`, `--nw`) sets up and locks a workspace
- [ ] `tim chat --base <branch>` checks out the specified branch in the workspace
- [ ] `tim chat --plan <plan>` resolves plan metadata and uses it for workspace assignment
- [ ] `tim chat --commit` commits changes after the session ends
- [ ] Workspace roundtrip sync runs when workspace mode is active
- [ ] Workspace lock is released on exit (including signals)
- [ ] Non-interactive mode (`--non-interactive`) works with workspace options
- [ ] When no workspace options are provided, `tim chat` behaves identically to current behavior
- [ ] Web UI sessions are correctly grouped under the workspace when workspace mode is active
- [ ] All new code paths are covered by tests

### Dependencies & Constraints

- **Dependencies**: Relies on existing `setupWorkspace()`, `prepareWorkspaceRoundTrip()`, `runPreExecutionWorkspaceSync()`, `runPostExecutionWorkspaceSync()`, `touchWorkspaceInfo()` from the workspace module
- **Technical Constraints**: `setupWorkspace()` was designed with plan data in mind — need to verify it handles plan-less operation gracefully
- **No breaking changes**: Existing `tim chat` behavior must be preserved when workspace options are not used

### Implementation Notes

- **Recommended Approach**: Enhance `tim chat` rather than creating a new command. The workspace lifecycle is a composable concern that can be conditionally applied.
- **Model**: Follow `generate.ts` as the reference implementation since it has the simplest workspace roundtrip pattern (single prompt execution, no iteration loops).
- **Potential Gotchas**:
  - `setupWorkspace()` may fail or behave unexpectedly with an empty plan file path — test this path carefully
  - The `createBranch` semantics change: for chat with `--base`, we want to check out an existing branch, not create new one
  - Workspace cleanup in the `finally` block must handle all error cases (generation error + sync error) like `generate.ts` does

## Current Progress
### Current State
- All 5 tasks completed and tests passing (34 chat tests, 43 workspace setup tests, 40 workspace manager tests)

### Completed (So Far)
- Task 1: setupWorkspace refactored — planFile parameter now optional (string | undefined), with effectiveCreateBranch logic to skip branch creation when no plan/base
- Task 2: CLI options added to chat command in tim.ts matching generate pattern
- Task 3: Full workspace lifecycle in handleChatCommand following generate.ts reference
- Task 4: 34 tests in chat.test.ts covering workspace mode, plan resolution, branch derivation, validation, roundtrip hooks, cleanup
- Task 5: README updated with workspace options documentation and examples

### Remaining
- None — all tasks complete

### Next Iteration Guidance
- None

### Decisions / Changes
- `--plan` alone implies `--auto-workspace` — no need to specify both
- `--base` and `--commit` require a workspace option (-w, --aw, --nw, or --plan) and will error if used standalone
- Branch is derived from plan data (plan.branch ?? generateBranchNameFromPlan) when --plan is provided without --base
- Post-sync always runs in workspace mode (matching generate/agent), independent of --commit flag
- `createBranch` added to `createWorkspace()` options type to allow per-call override
- `effectiveCreateBranch` in setupWorkspace enforces `false` when no plan file and no base branch

### Lessons Learned
- The workspace roundtrip post-sync unconditionally calls commitAll() — this is by design (matches generate/agent) but means --commit in chat callback is redundant when roundtrip is active. The callback commit exists for the case when sync is disabled.
- When adding new options that are modifiers of a mode (like --base requiring workspace mode), validate early with clear error messages rather than silently ignoring.
- The generate.ts workspace lifecycle pattern should be followed closely for consistency — deviations (like conditional touchedWorkspacePath) create subtle bugs that reviews catch.

### Risks / Blockers
- None
