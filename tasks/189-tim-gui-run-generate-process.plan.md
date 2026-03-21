---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: run generate command from web
goal: ""
id: 189
uuid: 9a812d63-4354-4355-ab9d-d254dcbef3b0
generatedBy: agent
status: in_progress
priority: medium
dependencies:
  - 184
  - 180
  - 183
  - 188
references:
  "180": 4d9ccb0b-e988-479a-8f5a-4920747c72ec
  "183": 9c58c35e-6447-4ce3-af6b-3510719dc560
  "184": 05e31645-305d-4e59-8c49-a9fbc9ce0bd7
  "188": 2f287626-23b9-4d02-9e15-983f6ba6d5fd
planGeneratedAt: 2026-03-20T23:51:20.469Z
promptsGeneratedAt: 2026-03-20T23:51:20.469Z
createdAt: 2026-02-13T21:11:06.976Z
updatedAt: 2026-03-21T08:08:24.187Z
tasks:
  - title: Add hasActiveSessionForPlan to SessionManager
    done: false
    description: "Add a method to src/lib/server/session_manager.ts that checks
      whether an active session exists for a given plan ID and command type.
      Returns { active: boolean; connectionId?: string }. Iterate this.sessions
      checking session.sessionInfo?.planId === planId &&
      session.sessionInfo?.command === command && session.status === active.
      Return the connectionId if found so the UI can link to it. Write tests in
      the existing session manager test file."
  - title: Add getPrimaryWorkspacePath query helper
    done: false
    description: Add a function to src/lib/server/db_queries.ts that queries the
      primary workspace path for a project. Query workspace table for project_id
      = ? AND workspace_type = 1 (WORKSPACE_TYPE_VALUES.primary), return
      workspace_path or null. Write a test for this alongside existing
      db_queries tests.
  - title: Create server-side spawn handler
    done: false
    description: "Create src/lib/server/plan_actions.ts with
      spawnGenerateProcess(planId, cwd) function. Spawns [tim, generate, planId,
      --auto-workspace, --no-terminal-input] via Bun.spawn with { detached:
      true, cwd, env: process.env, stdio: [ignore, ignore, pipe] }. Waits ~500ms
      and checks proc.exitCode — if non-null, reads stderr and returns {
      success: false, error: stderrContent }. If still alive, calls .unref() and
      returns { success: true, planId }. Write tests mocking Bun.spawn for early
      failure and successful spawn cases."
  - title: Create startGenerate remote command
    done: false
    description: "Create src/lib/remote/plan_actions.remote.ts following the pattern
      in src/lib/remote/session_actions.remote.ts. Define startGenerate command
      with Zod schema accepting { planUuid: string }. Handler: gets server
      context for DB access, looks up plan by UUID for planId and project_id,
      validates eligibility (no tasks, not done/cancelled), checks
      hasActiveSessionForPlan for duplicate prevention, calls
      getPrimaryWorkspacePath, calls spawnGenerateProcess, returns result. Write
      tests for the command logic covering plan not found, ineligible,
      duplicate, no primary workspace, successful spawn, and spawn failure."
  - title: Add Generate button to PlanDetail component
    done: false
    description: "Modify src/lib/components/PlanDetail.svelte: import
      useSessionManager and startGenerate. Add eligibility check
      (plan.tasks.length === 0 && displayStatus not done/cancelled). Add derived
      state checking session store for active generate session matching
      plan.planId. Add button in header area next to status/priority badges.
      States: hidden (ineligible), Generate (eligible), Generating... with
      session link (running), spinner (starting), error message (failed). On
      click call startGenerate({ planUuid: plan.uuid }), show confirmation +
      link to /projects/{projectId}/sessions/{connectionId} on success."
tags: []
---

This should work as if `tim generate <planId> --auto-workspace` was run from the command line in the primary workspace.

We'll want some kind of daemonization on the subprocess so that if the web server restarts or we're in the dev server,
we don't lose the process.

## Research

### Overview

The goal is to add a "Generate" button to the web interface's plan detail page that spawns `tim generate <planId> --auto-workspace` as if run from the primary workspace's command line. The spawned process must survive web server restarts (especially during dev with HMR). The process will connect back to the web server via the existing HeadlessAdapter/WebSocket session system, so the user can monitor it in real-time in the Sessions tab.

### Key Findings

#### 1. The `generate` command flow (`src/tim/commands/generate.ts`)

The `handleGenerateCommand` function orchestrates:
1. Plan resolution and validation (must be a stub plan with no tasks)
2. Workspace setup via `setupWorkspace()` — handles auto-workspace selection, lock acquisition, branch handling
3. Prompt building via `buildPromptText()` with mode selection (`generate-plan` or `generate-plan-simple`)
4. Executor construction via `buildExecutorAndLog()` — typically the Claude Code executor
5. Execution wrapped in `runWithHeadlessAdapterIfEnabled()` which creates a HeadlessAdapter WebSocket connection to the web server
6. Post-execution: plan sync to DB, workspace sync, lock release, timestamp touch

The function takes `planArg` (plan ID or path), `options` object, and `command` (commander Command for accessing parent opts). The options include `autoWorkspace`, `workspace`, `newWorkspace`, `nonInteractive`, `requireWorkspace`, `createBranch`, `base`, `executor`, `simple`, `commit`, `workspaceSync`, `terminalInput`.

The generate command is invoked via the CLI (`src/tim/tim.ts` lines 313-354) which sets up Commander options. From the web, we spawn `tim generate <planId> --auto-workspace --no-terminal-input` as a shell command. This is maximally decoupled and avoids entangling the web server process with executor lifecycle, workspace locking, signal handling, and cleanup.

#### 2. Process daemonization requirements

The codebase currently has **no detached process spawning**. All `Bun.spawn` calls use attached stdio pipes. The requirement is that the `tim generate` subprocess survives web server restarts (especially HMR in dev).

Approach: Use `Bun.spawn` with `{ detached: true }` and call `.unref()` on the subprocess. This creates a process group leader that won't be killed when the parent exits. The process will still connect to the web server via WebSocket (HeadlessAdapter) and will appear as a session.

The spawned process needs:
- Working directory: the plan's project primary workspace path (from DB)
- Environment: inherit from web server process (includes `ANTHROPIC_API_KEY`, `PATH`, etc.)
- The `--no-terminal-input` flag since stdin is unavailable
- No `--non-interactive` — prompts flow through the HeadlessAdapter to the web UI

To detect early spawn failures, pipe stderr and wait ~500ms before detaching. If the process dies immediately, return the error to the client.

#### 3. HeadlessAdapter and session reconnection

When `tim generate` runs, it calls `runWithHeadlessAdapterIfEnabled()` (enabled when `!isTunnelActive()`). This creates a `HeadlessAdapter` that connects to `ws://localhost:8123/tim-agent` and streams output to the web server's `SessionManager`.

The HeadlessAdapter has **built-in reconnection** with exponential backoff. If the web server restarts, the adapter will reconnect and replay its message history. This means the spawned process naturally handles web server restarts — it will buffer messages and reconnect when the server comes back.

Key session info sent on connect (`src/tim/headless.ts:buildHeadlessSessionInfo`):
- `command`: 'generate'
- `interactive`: true (for generate)
- `planId`, `planTitle`
- `workspacePath`, `gitRemote`
- `terminalPaneId`, `terminalType`

#### 4. SvelteKit `command` remote functions

The codebase uses SvelteKit's `command` API from `$app/server` for server-side actions triggered from the browser. This is the pattern to use instead of a manual API route.

Existing example: `src/lib/remote/session_actions.remote.ts` defines `activateSessionTerminalPane` using `command()` with a Zod schema for input validation. The client imports and calls the function directly — SvelteKit handles the underlying fetch automatically.

Pattern:
- Define in `src/lib/remote/*.remote.ts` with `command()` from `$app/server` and a Zod schema
- Server handler receives validated input, performs the action, returns a result
- Client imports the function and calls it like a regular async function
- Built-in `.pending` property for tracking in-flight state

#### 5. Plan detail component (`src/lib/components/PlanDetail.svelte`)

Currently **purely display-only** with no action buttons. The component receives `plan: PlanDetail`, `projectId`, `projectName`, and `tab` props. Adding a "Generate" button in the header area (next to status/priority badges) requires:
- Checking eligibility: plan must be a stub (no tasks), not done/cancelled
- Client-side duplicate check via `useSessionManager()` to see if a generate session is already running for this planId
- Calling the remote command function on click
- Showing confirmation + link to sessions tab on success

The `PlanDetail` type from `src/lib/server/db_queries.ts` includes `tasks` array, `displayStatus`, `planId`, `uuid`, and other fields needed to determine eligibility.

#### 6. Primary workspace lookup

The spawned process needs to run from the plan's project primary workspace. The workspace DB table stores `workspace_type` (0=standard, 1=primary, 2=auto) and `workspace_path`. To find the primary workspace:
- Look up the plan by UUID to get its `project_id`
- Query workspaces for that project where `workspace_type = 1` (primary)
- Use that workspace's `workspace_path` as cwd

No existing helper exists for this query — one needs to be added (e.g., in `src/lib/server/db_queries.ts` or `src/tim/db/workspace.ts`).

#### 7. Session-based duplicate detection

The client-side session store (`useSessionManager()`) already has all active sessions via SSE. The `PlanDetail` component can check for an active generate session matching the plan's numeric ID to show "Generating..." state immediately without a round-trip.

The server-side command handler also checks as a safety net before spawning.

The `SessionManager` needs a helper method like `hasActiveSessionForPlan(planId, command)` that iterates active sessions.

#### 8. Relevant files and modules

**Files to create:**
- `src/lib/remote/plan_actions.remote.ts` — Remote command for spawning the generate process
- `src/lib/server/plan_actions.ts` — Server-side handler implementing the spawn logic

**Files to modify:**
- `src/lib/components/PlanDetail.svelte` — Add "Generate" button with eligibility and running-state logic
- `src/lib/server/session_manager.ts` — Add `hasActiveSessionForPlan()` helper

**Files to reference (read-only):**
- `src/lib/remote/session_actions.remote.ts` — Pattern for remote command definition
- `src/tim/commands/generate.ts` — Understand what CLI options to pass
- `src/tim/headless.ts` — Understand how sessions connect
- `src/lib/server/ws_server.ts` — Understand session connection flow
- `src/lib/server/session_manager.ts` — Understand session tracking
- `src/lib/server/db_queries.ts` — Understand PlanDetail type and workspace queries
- `src/tim/db/workspace.ts` — Workspace type constants

### Design Decisions

**Shell command via `command` remote function**: Spawn `tim generate <planId> --auto-workspace --no-terminal-input` as a detached process from a SvelteKit `command` remote function. The `command` pattern matches the existing codebase convention and provides type-safe client-server communication without manual API routes.

**No `--non-interactive`**: Prompts from the generate process flow through the HeadlessAdapter to the web UI's session system. Users can answer permission prompts and interact through the Sessions tab.

**Primary workspace from DB**: The spawn cwd is determined by looking up the primary workspace for the plan's project in the database, not from `process.cwd()` or git root.

**Detached process with early failure detection**: Use `Bun.spawn` with `{ detached: true }`, pipe stderr, wait ~500ms to verify the process started successfully, then `.unref()`. This provides meaningful error reporting for immediate failures (command not found, etc.) while ensuring the process survives server restarts.

**Dual duplicate detection**: Client-side via session store for immediate UI feedback, server-side in the command handler as a safety net.

## Implementation Guide

### Expected Behavior/Outcome

When viewing a plan detail page for a stub plan (no tasks), the user sees a "Generate" button in the header area. Clicking it:
1. Spawns `tim generate <planId> --auto-workspace --no-terminal-input` as a detached process from the plan's primary workspace
2. Shows confirmation message with a link to the Sessions tab
3. The process appears as a new session within seconds
4. The user can monitor generation progress, respond to prompts, and see results through the existing session UI
5. If a generate process is already running for this plan, the button shows "Generating..." with a link to the session

**States:**
- **Eligible**: Plan has no tasks, status is not `done`/`cancelled`, no active generate session → "Generate" button shown and enabled
- **Hidden**: Plan has tasks or is done/cancelled → button not shown
- **Running**: Active generate session exists for this plan → button disabled, shows "Generating..." with link to session
- **Starting**: Command call in flight → button disabled with spinner
- **Error**: Spawn failed → error message shown briefly

### Key Findings

**Product & User Story**: As a tim web user viewing a plan that needs generation, I want to click a button to start the generate process without switching to the terminal, and then monitor it through the existing sessions UI.

**Design & UX Approach**: Minimal UI addition — a single button on the plan detail header area. No new pages or complex flows. Leverage the existing sessions infrastructure for monitoring. Stay on plan page after clicking, show confirmation + link.

**Technical Plan & Risks**:
- Risk: The `tim` CLI binary must be in PATH for the web server process. This should normally be the case since the web server is started from the same environment.
- Risk: Environment variables (especially `ANTHROPIC_API_KEY`) must be available to the spawned process. Since we inherit the web server's env, this should work.
- Risk: Process orphaning if something goes wrong — mitigated by workspace lock timeouts and the generate command's own cleanup handlers.

**Pragmatic Effort Estimate**: Small-medium feature. The core mechanism (spawn a detached CLI command) is simple. Most work is in the remote command, UI button with state management, and testing.

### Acceptance Criteria

- [ ] User can click "Generate" on an eligible plan detail page and a `tim generate` process starts
- [ ] The spawned process appears as a session in the Sessions tab
- [ ] The spawned process survives web server restart (HMR in dev)
- [ ] The button is hidden for ineligible plans (has tasks, done, cancelled)
- [ ] The button shows "Generating..." state when a generate session is already running for this plan
- [ ] Duplicate generation for the same plan is prevented (server-side guard)
- [ ] Early spawn failures (~500ms) are detected and reported to the user
- [ ] All new code paths are covered by tests

### Dependencies & Constraints

- **Dependencies**: Relies on the existing HeadlessAdapter/WebSocket session infrastructure, the `tim generate` CLI command, the plan detail component, and SvelteKit `command` remote functions.
- **Technical Constraints**: The `tim` binary must be accessible in the web server's PATH. The web server's environment must include required env vars (API keys). The plan's project must have a primary workspace registered in the database.

### Implementation Notes

#### Step 1: Add `hasActiveSessionForPlan` to SessionManager

Add a method to `src/lib/server/session_manager.ts` that checks whether an active session exists for a given plan ID and command type.

```typescript
hasActiveSessionForPlan(planId: number, command: string): { active: boolean; connectionId?: string }
```

Iterate `this.sessions` and check `session.sessionInfo?.planId === planId && session.sessionInfo?.command === command && session.status === 'active'`. Return the `connectionId` if found so the UI can link to it.

Write a test for this in the existing session manager test file.

#### Step 2: Add primary workspace query helper

Add a function to query the primary workspace path for a project. This can go in `src/lib/server/db_queries.ts` alongside the existing `getWorkspacesForProject`.

```typescript
export function getPrimaryWorkspacePath(db: Database, projectId: number): string | null
```

Query the workspace table for `project_id = ? AND workspace_type = 1` (WORKSPACE_TYPE_VALUES.primary) and return `workspace_path`. Return null if no primary workspace is found.

#### Step 3: Create the server-side spawn handler

Create `src/lib/server/plan_actions.ts` with the core spawn logic:

```typescript
export async function spawnGenerateProcess(planId: number, cwd: string): Promise<{ success: boolean; error?: string }>
```

This function:
1. Spawns `['tim', 'generate', String(planId), '--auto-workspace', '--no-terminal-input']` via `Bun.spawn`
2. Uses `{ detached: true, cwd, env: process.env, stdio: ['ignore', 'ignore', 'pipe'] }` — pipe stderr only
3. Waits ~500ms and checks if the process is still alive (check `proc.exitCode` — if non-null, it died early)
4. If the process died early, reads stderr and returns `{ success: false, error: stderrContent }`
5. If still alive, calls `.unref()` on the process and returns `{ success: true }`

#### Step 4: Create the remote command

Create `src/lib/remote/plan_actions.remote.ts` following the pattern in `src/lib/remote/session_actions.remote.ts`.

Define a `startGenerate` command with a Zod schema accepting `{ planUuid: string }`.

The handler:
1. Gets server context via `getServerContext()` for DB access
2. Looks up the plan by UUID to get its `planId` (numeric) and `project_id`
3. Validates the plan is eligible (has no tasks, not done/cancelled)
4. Gets the session manager via `getSessionManager()` and checks `hasActiveSessionForPlan` — if already running, return an appropriate error or status with the connectionId
5. Calls `getPrimaryWorkspacePath(db, projectId)` — if no primary workspace found, return error
6. Calls `spawnGenerateProcess(planId, primaryWorkspacePath)`
7. Returns the result (success/failure with error message)

#### Step 5: Add "Generate" button to PlanDetail component

Modify `src/lib/components/PlanDetail.svelte`:

1. Import `useSessionManager` from `$lib/stores/session_state.svelte.ts`
2. Import `startGenerate` from `$lib/remote/plan_actions.remote.js`
3. Add eligibility check: `plan.tasks.length === 0 && plan.displayStatus !== 'done' && plan.displayStatus !== 'cancelled'`
4. Add a derived state that checks the session store for an active generate session matching `plan.planId` — iterate `sessionManager.sessions` looking for `sessionInfo.planId === plan.planId && sessionInfo.command === 'generate' && status === 'active'`
5. Add the button in the header area (same row as status/priority badges):
   - When eligible and not running: "Generate" button
   - When running: "Generating..." disabled button with link to session (using connectionId to build `/projects/{projectId}/sessions/{connectionId}`)
   - When starting (call in flight): disabled button with spinner
6. On click: call `startGenerate({ planUuid: plan.uuid })`, show confirmation + link on success, show error on failure
7. Track in-flight state with a local `$state` variable (or use `startGenerate.pending`)

#### Step 6: Write tests

- **SessionManager test**: Test `hasActiveSessionForPlan` — returns active session when exists, returns null when no match, handles edge cases (offline sessions, different commands, different planIds)
- **DB query test**: Test `getPrimaryWorkspacePath` — returns path when primary workspace exists, returns null when not found
- **Spawn handler test**: Test `spawnGenerateProcess` — mock `Bun.spawn` to verify correct arguments, test early failure detection (mock process that exits immediately with stderr), test successful spawn (mock process that stays alive)
- **Remote command test**: Test the `startGenerate` command logic — plan not found, plan ineligible, duplicate detection, successful spawn, spawn failure

### Manual Testing Steps

1. Start the web server (`bun run dev`)
2. Navigate to a stub plan's detail page
3. Click "Generate" — verify process spawns and appears in Sessions tab
4. Verify the button shows "Generating..." while the session is active
5. Verify the button is hidden for plans with tasks
6. Kill and restart the web server — verify the generate process continues running
7. Verify the session reconnects after server restart

### Potential Gotchas

- **Config path**: The spawned `tim generate` needs to find the right config. It uses `loadEffectiveConfig()` which reads from the XDG config directory. This should work automatically since env vars are inherited.
- **Workspace locking**: The auto-workspace selection may create a new workspace if all are locked. This is fine — it's the expected behavior.
- **Process cleanup on error**: If the spawn itself fails (command not found, etc.), the ~500ms wait detects it. If the process fails later, it shows up in the session UI.
- **No primary workspace**: If the plan's project doesn't have a primary workspace registered, the command returns an error. This is an edge case that should be communicated clearly to the user.
