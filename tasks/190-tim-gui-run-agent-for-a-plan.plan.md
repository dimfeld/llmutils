---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: run agent command for a plan from web interface
goal: ""
id: 190
uuid: 822217b3-06f6-4200-b958-dae9bfd31ba0
generatedBy: agent
status: pending
priority: medium
dependencies:
  - 184
  - 183
  - 180
  - 188
  - 189
references:
  "180": 4d9ccb0b-e988-479a-8f5a-4920747c72ec
  "183": 9c58c35e-6447-4ce3-af6b-3510719dc560
  "184": 05e31645-305d-4e59-8c49-a9fbc9ce0bd7
  "188": 2f287626-23b9-4d02-9e15-983f6ba6d5fd
  "189": 9a812d63-4354-4355-ab9d-d254dcbef3b0
planGeneratedAt: 2026-03-21T09:20:29.522Z
promptsGeneratedAt: 2026-03-21T09:20:29.522Z
createdAt: 2026-02-13T21:11:54.474Z
updatedAt: 2026-03-21T09:20:29.522Z
tasks:
  - title: Generalize the process spawning function
    done: false
    description: Refactor spawnGenerateProcess() in src/lib/server/plan_actions.ts
      into a shared spawnTimProcess(args, cwd) function. Create
      spawnAgentProcess(planId, cwd) that calls it with ["agent", planId,
      "--auto-workspace", "--no-terminal-input"]. Refactor
      spawnGenerateProcess() to also use the shared function. Rename types from
      SpawnGenerate* to SpawnProcess* since they are now shared.
  - title: Make hasActiveSessionForPlan command-agnostic and update startGenerate
    done: false
    description: In src/lib/server/session_manager.ts, make the command parameter
      optional in hasActiveSessionForPlan(planId, command?). When command is
      omitted, match any active session for the plan regardless of command type.
      Update startGenerate in src/lib/remote/plan_actions.remote.ts to call
      hasActiveSessionForPlan(plan.planId) without the command argument. Update
      PlanDetail.svelte active session detection to be command-agnostic. Update
      existing startGenerate tests to reflect the new behavior and add a
      cross-command test (startGenerate returns already_running when an agent
      session is active).
  - title: Add the startAgent remote command
    done: false
    description: "In src/lib/remote/plan_actions.remote.ts, add startAgent command
      following the startGenerate pattern. Create isPlanEligibleForAgent(plan):
      not done/cancelled/deferred, and if tasks exist then not all done (plans
      without tasks are allowed for simple/stub plans). Validate eligibility,
      check for any active session on the plan (command-agnostic), get primary
      workspace path, spawn agent process. Return {status: started, planId} or
      {status: already_running, connectionId}."
  - title: Add split action button to PlanDetail UI
    done: false
    description: "Refactor PlanDetail.svelte to use a split action button with
      ButtonGroup and DropdownMenu UI components. Plans with incomplete tasks:
      default action is Run Agent (no dropdown for now). Plans without tasks:
      default action is Generate, dropdown includes Run Agent for simple/stub
      plans. Ineligible or all-done plans show no action button. When running
      agent on a blocked plan (displayStatus === blocked), show confirm() dialog
      before proceeding. Active session detection is command-agnostic — if any
      session is active, show Running... link with pulse indicator pointing to
      the session."
  - title: Write tests for startAgent remote command
    done: false
    description: "Add describe(startAgent) block in
      src/lib/remote/plan_actions.remote.test.ts. Test cases: rejects missing
      plans (404), rejects done/cancelled/deferred plans (400), rejects plans
      with all tasks done (400), allows plans without tasks, returns
      already_running when active agent session exists, returns already_running
      when active generate session exists (cross-command), ignores offline
      sessions and starts new process, rejects plans without primary workspace
      (400), successfully spawns agent, surfaces spawn failures (500). Enhance
      seedPlan() helper if needed to support tasks with done state."
tags: []
---

This should work as if `tim agent <planId> --auto-workspace` was run from the command line in the primary workspace.

We'll want some kind of daemonization on the subprocess so that if the web server restarts or we're in the dev server,
we don't lose the process. See plan 189

## Research

### Overview

This plan adds the ability to run `tim agent` for a plan directly from the web interface, mirroring the existing "Generate" button functionality that was implemented in plan 189. The agent command is the primary execution engine — it reads a plan's tasks, spawns LLM executors, and iterates through tasks to completion. Running it from the web UI enables users to kick off plan execution without switching to a terminal.

### Key Findings

#### 1. Existing `startGenerate` Pattern (Plan 189) — Direct Blueprint

Plan 189 implemented `tim generate` launching from the web. The architecture is a near-perfect template for `tim agent`:

**Files involved:**
- `src/lib/server/plan_actions.ts` — `spawnGenerateProcess()`: spawns `tim generate` with `Bun.spawn()`, `detached: true`, `.unref()`, 500ms early exit check
- `src/lib/remote/plan_actions.remote.ts` — `startGenerate` remote command: validates plan eligibility, checks for duplicate sessions, gets primary workspace path, spawns process
- `src/lib/components/PlanDetail.svelte` — UI button with eligibility logic, active session detection, starting/error/success states
- `src/lib/remote/plan_actions.remote.test.ts` — comprehensive tests using `invokeCommand()` helper with mocked DB, session manager, and spawn function

**Process spawning pattern:**
```
Bun.spawn(['tim', 'generate', planId, '--auto-workspace', '--no-terminal-input'], {
  cwd: primaryWorkspacePath,
  env: process.env,
  stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
  detached: true
})
```
After 500ms, if process hasn't exited, call `proc.stderr.cancel()` and `proc.unref()`.

#### 2. Differences Between `generate` and `agent` Eligibility

**Generate eligibility** (`isPlanEligibleForGenerate`):
- Plan must have NO tasks (tasks.length === 0)
- Plan must NOT be done, cancelled, or deferred

**Agent eligibility** (new — `isPlanEligibleForAgent`):
- Plan must NOT be done, cancelled, or deferred
- If plan has tasks, must have incomplete tasks (not all tasks done)
- Plans without tasks are allowed (simple/stub plans that skip generate)
- Blocked plans are allowed but require a confirmation dialog in the UI

Generate and agent are not mutually exclusive — a plan without tasks is eligible for both. The UI uses a split button: plans without tasks default to "Generate" with "Run Agent" in a dropdown; plans with tasks default to "Run Agent".

#### 3. Agent Command CLI Arguments

The `tim agent` command (in `src/tim/commands/agent/agent.ts`) accepts many options, but for web launching, we need minimal flags:

**Required flags:**
- `<planId>` — the plan ID or file path (numeric ID works)
- `--auto-workspace` — auto-select available workspace
- `--no-terminal-input` — since there's no terminal

**The agent command's `handleAgentCommand()` wraps in `runWithHeadlessAdapterIfEnabled()`** which creates a HeadlessAdapter WebSocket connection to the WS server. This means the spawned agent process will automatically connect back to the web UI session infrastructure with `command: 'agent'`.

#### 4. Session Infrastructure — Already Supports Agent

The `SessionManager.hasActiveSessionForPlan(planId, command)` method accepts any command string. The HeadlessAdapter sends `session_info` with `command: 'agent'` when running `tim agent`. Session tracking and UI display already work. The `command` parameter will be made optional so that duplicate detection prevents any concurrent execution on the same plan (regardless of whether it's a generate or agent session).

#### 5. UI Component Structure

`PlanDetail.svelte` currently has:
- `eligible` derived state: `plan.tasks.length === 0 && !INELIGIBLE_STATUSES.has(plan.displayStatus)`
- `activeGenerateSession` derived state: searches sessions for `command === 'generate'`
- `handleGenerate()` async handler
- Button/link rendering with starting/error/success states

For agent support, we need:
- A split action button: plans with tasks default to "Run Agent"; plans without tasks default to "Generate" with "Run Agent" in a dropdown
- A single `activeSession` derived state searching for any active session on the plan (command-agnostic)
- Handlers for both `handleGenerate()` and `handleRunAgent()`
- Confirmation dialog when running agent on blocked plans
- Use existing `ButtonGroup` and `DropdownMenu` UI components for the split button

#### 6. Process Spawn Function — Generalize or Duplicate

`spawnGenerateProcess()` in `src/lib/server/plan_actions.ts` is specific to generate. Two approaches:

**Option A: Generalize** — Create a shared `spawnTimProcess(command, planId, cwd, extraArgs?)` function that both generate and agent use.

**Option B: Separate function** — Create `spawnAgentProcess(planId, cwd)` alongside the existing generate function.

Option A is cleaner since the spawn logic is identical except for the command and flags. The early exit check, detach, and unref pattern are the same.

#### 7. Test Infrastructure

The test file `src/lib/remote/plan_actions.remote.test.ts` uses:
- `invokeCommand()` from `$lib/test-utils/invoke_command.js` — wrapper to call SvelteKit commands in tests
- Mocked `getServerContext()`, `getSessionManager()`, `spawnGenerateProcess()`
- `seedPlan()` helper to create test plans with configurable tasks and status
- Direct `SessionManager` instantiation for session state testing

The same patterns apply directly for agent tests.

#### 8. HeadlessSessionInfo Command Field

In `src/logging/headless_protocol.ts`, the `HeadlessSessionInfo.command` field supports values including `'agent'`. The session manager categorizes sessions by this field. The web UI's `SessionRow` and `SessionList` components display sessions regardless of command type — they already handle agent sessions from CLI-initiated runs.

### Notable Files and Patterns

| File | Purpose |
|------|---------|
| `src/lib/server/plan_actions.ts` | Process spawning with detach pattern |
| `src/lib/remote/plan_actions.remote.ts` | Remote command with validation pipeline |
| `src/lib/remote/plan_actions.remote.test.ts` | Test patterns for remote commands |
| `src/lib/components/PlanDetail.svelte` | UI button states and session detection |
| `src/lib/server/db_queries.ts` | `getPlanDetail()`, `getPrimaryWorkspacePath()` |
| `src/lib/server/session_manager.ts` | `hasActiveSessionForPlan(planId, command)` |
| `src/lib/server/session_context.ts` | Session manager singleton |
| `src/tim/commands/agent/agent.ts` | Agent CLI entry point (`handleAgentCommand`) |
| `src/lib/test-utils/invoke_command.js` | Test helper for SvelteKit commands |

### Architectural Constraints

1. **Primary workspace must exist** — The spawned process needs a `cwd`. The primary workspace is looked up from the DB via `getPrimaryWorkspacePath()`.
2. **Detached spawning** — Must use `detached: true` + `.unref()` for process to survive web server restarts/HMR.
3. **Session-based duplicate prevention** — Check `hasActiveSessionForPlan(planId)` (without command filter) before spawning to prevent any concurrent execution on the same plan. This applies to both `startGenerate` and `startAgent`. The `hasActiveSessionForPlan` method should be updated to make `command` optional.
4. **SvelteKit `command()` pattern** — Remote commands use this RPC mechanism, not REST API endpoints.
5. **Agent uses `--auto-workspace`** — This is specified in the plan description. The agent will auto-select or create a workspace.

## Implementation Guide

### Step 1: Generalize the Process Spawning Function

**File:** `src/lib/server/plan_actions.ts`

Refactor `spawnGenerateProcess()` into a more general `spawnTimProcess()` that accepts the command and arguments:

1. Create `spawnTimProcess(args: string[], cwd: string): Promise<SpawnResult>` that takes the full args array
2. Refactor `spawnGenerateProcess()` to call `spawnTimProcess(['generate', planId, '--auto-workspace', '--no-terminal-input'], cwd)`
3. Add `spawnAgentProcess(planId: number, cwd: string)` that calls `spawnTimProcess(['agent', planId, '--auto-workspace', '--no-terminal-input'], cwd)`

Keep the existing `SpawnGenerateResult` types but consider renaming to `SpawnProcessResult` since they're now shared. Or introduce a type alias.

The 500ms early exit check, stderr piping, detach, and unref logic stays in `spawnTimProcess()`.

### Step 2: Make `hasActiveSessionForPlan` Command-Agnostic and Update `startGenerate`

**Files:** `src/lib/server/session_manager.ts`, `src/lib/remote/plan_actions.remote.ts`

1. Make the `command` parameter optional in `hasActiveSessionForPlan(planId, command?)`. When `command` is omitted, match any active session for the plan regardless of command type.
2. Update `startGenerate` to call `hasActiveSessionForPlan(plan.planId)` without the command argument, so it also blocks if an agent session is already running on the same plan.
3. Update the existing `startGenerate` test for active session detection to reflect the new behavior (no command filter).
4. Also update PlanDetail.svelte's `activeGenerateSession` derived state to check for any active session on the plan, not just `command === 'generate'`. This affects both generate and agent — whichever is active, the UI should show the "running" link.

### Step 3: Add the `startAgent` Remote Command

**File:** `src/lib/remote/plan_actions.remote.ts`

Add a new `startAgent` command following the `startGenerate` pattern:

1. Define `startAgentSchema = z.object({ planUuid: z.string().min(1) })`
2. Create `isPlanEligibleForAgent(plan)` function:
   - Plan is not null
   - Status is not `done`, `cancelled`, or `deferred`
   - If plan has tasks, must have incomplete tasks (`plan.taskCounts.done < plan.taskCounts.total`)
   - Plans without tasks are allowed (simple/stub plans that skip generate)
3. Create the `startAgent` command:
   - Load plan from DB via `getPlanDetail(db, planUuid)`
   - Validate eligibility with `isPlanEligibleForAgent()`
   - Check for any active session on this plan via `getSessionManager().hasActiveSessionForPlan(plan.planId)` (regardless of command type — prevent concurrent generate and agent on the same plan)
   - Get primary workspace path
   - Spawn agent process via `spawnAgentProcess(plan.planId, primaryWorkspacePath)`
   - Return `{ status: 'started', planId }` or `{ status: 'already_running', connectionId }`

### Step 4: Add Split Action Button to PlanDetail UI

**File:** `src/lib/components/PlanDetail.svelte` (and a new `ActionButton.svelte` component)

Build a split action button with a default action and an optional dropdown for secondary actions:

**Component structure:**
- Use existing UI primitives: `ButtonGroup` from `$lib/components/ui/button-group` for the split layout, and `DropdownMenu` / `DropdownMenuTrigger` / `DropdownMenuContent` / `DropdownMenuItem` from `$lib/components/ui/dropdown-menu` for the secondary actions menu
- The button shows the default action as the main click target, with a small dropdown arrow button on the right (inside the ButtonGroup) if secondary actions exist
- Clicking the main area triggers the default action; clicking the arrow opens the dropdown menu

**Action logic in PlanDetail.svelte:**

1. Import both `startGenerate` and `startAgent` from the remote module
2. Determine plan action state:
   - `isBlocked`: `plan.displayStatus === 'blocked'`
   - `hasTasks`: `plan.tasks.length > 0`
   - `hasIncompleteTasks`: `plan.taskCounts.done < plan.taskCounts.total`
   - `isIneligibleStatus`: status is done, cancelled, deferred, or recently_done
3. Compute available actions:
   - **Plans with tasks + incomplete tasks + not ineligible status:** Default action is "Run Agent". No dropdown actions for now.
   - **Plans without tasks + not ineligible status:** Default action is "Generate". Dropdown includes "Run Agent" (for simple/stub plans).
   - **Ineligible plans or plans with all tasks done:** No actions shown.
4. Track `isBlocked` — when running agent on a blocked plan, show `confirm()` dialog first ("This plan has unresolved dependencies. Run agent anyway?")
5. Active session detection: check for any active session on the plan (regardless of command type). If found, replace the button with a "Running..." link to the session (with pulse indicator).
6. Share starting/error/success state since only one action runs at a time.

### Step 5: Write Tests for the Remote Command

**File:** `src/lib/remote/plan_actions.remote.test.ts`

Add a new `describe('startAgent')` block with tests mirroring the generate tests:

1. Rejects missing plans (404)
2. Rejects done/cancelled/deferred plans (400)
3. Rejects plans where all tasks are done (400)
4. Allows plans without tasks (simple/stub plans)
5. Returns `already_running` when active agent session exists
6. Returns `already_running` when active generate session exists on the same plan (cross-command duplicate prevention)
7. Ignores offline agent sessions and starts new process
8. Rejects plans without primary workspace (400)
9. Successfully spawns agent from primary workspace
10. Surfaces spawn failures (500)

Also add a cross-command test to `startGenerate`: returns `already_running` when an active agent session exists.

Use the existing `seedPlan()` helper (may need to enhance it to support tasks with done/not-done states).

### Manual Testing Steps

1. Navigate to a plan with tasks in the web UI
2. Verify "Run Agent" button appears (not "Generate")
3. Click "Run Agent" — verify the button shows "Starting..." spinner
4. Verify success message appears
5. Verify the button changes to "Running Agent..." link with pulse indicator
6. Click the link to view the active session
7. Navigate to a plan with no tasks — verify "Generate" is the default with "Run Agent" in dropdown
8. Navigate to a completed plan — verify no action button appears
9. Navigate to a blocked plan — verify "Run Agent" appears, clicking shows confirmation dialog

### Rationale

The approach mirrors the generate button exactly because:
- The infrastructure (spawn, session tracking, WebSocket, SSE) is already proven
- Users get a consistent experience between generate and agent
- The agent command already supports `--auto-workspace` and headless adapter
- Duplicate detection and session monitoring work identically
- The only meaningful difference is the CLI command and eligibility criteria
