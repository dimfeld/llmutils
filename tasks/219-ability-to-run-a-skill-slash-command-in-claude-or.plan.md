---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Ability to run a prompt in claude or codex in a workspace against a
  particular branch
goal: ""
id: 219
uuid: 9a638137-5cb4-46a0-9f13-bf129cd3efdb
status: pending
priority: medium
createdAt: 2026-03-07T07:43:56.083Z
updatedAt: 2026-03-20T22:38:40.333Z
tasks: []
tags: []
---

Run interactive by default but we should be able to run non-interactively. This should participate in the full workspace
roundtrip flow.

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
