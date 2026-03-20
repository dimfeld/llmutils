---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: run generate command from web
goal: ""
id: 189
uuid: 9a812d63-4354-4355-ab9d-d254dcbef3b0
status: pending
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
createdAt: 2026-02-13T21:11:06.976Z
updatedAt: 2026-03-20T22:42:09.090Z
tasks: []
tags: []
---

This should work as if `tim generate <planId> --auto-workspace` was run from the command line in the primary workspace.

We'll want some kind of daemonization on the subprocess so that if the web server restarts or we're in the dev server,
we don't lose the process.

## Research

### Overview

The goal is to add a "Run Generate" button to the web interface's plan detail page that spawns `tim generate <planId> --auto-workspace` as if run from the primary workspace's command line. The spawned process must survive web server restarts (especially during dev with HMR). The process will connect back to the web server via the existing HeadlessAdapter/WebSocket session system, so the user can monitor it in real-time in the Sessions tab.

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

Key observation: The generate command is invoked via the CLI (`src/tim/tim.ts` lines 313-354) which sets up Commander options. To call it from the web, we need to either:
- Spawn `tim generate <planId> --auto-workspace` as a shell command (simplest, most decoupled)
- Extract and call the core logic programmatically (complex, tightly coupled)

The shell command approach is strongly preferred because it matches the stated requirement ("as if run from the command line") and avoids entangling the web server process with executor lifecycle, workspace locking, signal handling, and cleanup.

#### 2. Process daemonization requirements

The codebase currently has **no detached process spawning**. All `Bun.spawn` calls use attached stdio pipes. The requirement is that the `tim generate` subprocess survives web server restarts (especially HMR in dev).

Approach: Use `Bun.spawn` with `{ detached: true }` and call `.unref()` on the subprocess. This creates a process group leader that won't be killed when the parent exits. The process will still connect to the web server via WebSocket (HeadlessAdapter) and will appear as a session.

The spawned process needs:
- Working directory: the primary workspace (git root)
- Environment: inherit from web server process (includes `ANTHROPIC_API_KEY`, `PATH`, etc.)
- The `--non-interactive` flag since there's no terminal
- The `--no-terminal-input` flag since stdin is unavailable

#### 3. HeadlessAdapter and session reconnection

When `tim generate` runs, it calls `runWithHeadlessAdapterIfEnabled()` (enabled when `!isTunnelActive()`). This creates a `HeadlessAdapter` that connects to `ws://localhost:8123/tim-agent` and streams output to the web server's `SessionManager`.

The HeadlessAdapter has **built-in reconnection** with exponential backoff. If the web server restarts, the adapter will reconnect and replay its message history. This means the spawned process naturally handles web server restarts — it will buffer messages and reconnect when the server comes back.

Key session info sent on connect (`src/tim/headless.ts:buildHeadlessSessionInfo`):
- `command`: 'generate'
- `interactive`: true (for generate)
- `planId`, `planTitle`
- `workspacePath`, `gitRemote`
- `terminalPaneId`, `terminalType`

#### 4. Web server API route patterns

Existing API routes follow a consistent pattern (`src/routes/api/sessions/`):
- POST handlers with JSON body parsing via `parseJsonBody()`
- Response helpers: `success()`, `badRequest()`, `notFound()` from `src/lib/server/session_routes.ts`
- Access to server context via `getServerContext()` and session manager via `getSessionManager()`

A new API route `POST /api/plans/[planUuid]/generate` would follow this pattern.

#### 5. Plan detail component (`src/lib/components/PlanDetail.svelte`)

Currently **purely display-only** with no action buttons. The component receives `plan: PlanDetail`, `projectId`, `projectName`, and `tab` props. Adding a "Generate" button requires:
- Checking eligibility: plan must be a stub (no tasks), not done, not already running
- Making a POST to the new API endpoint
- Showing loading/error states
- Potentially navigating to the sessions tab to see the running process

The `PlanDetail` type from `src/lib/server/db_queries.ts` includes `tasks` array, `displayStatus`, `planId`, `uuid`, and other fields needed to determine eligibility.

#### 6. Server context and config access

The web server already has access to:
- `TimConfig` via `getServerContext()` — needed for config path resolution
- `Database` via `getServerContext()` — needed for plan lookups
- Git root can be derived from config or the primary workspace
- Plan file paths can be resolved from the tasks directory

The `getServerContext()` in `src/lib/server/init.ts` returns `{ config, db }`. The config is loaded via `loadGlobalConfigForNotifications()`.

To resolve plan files, we need the `tasksDir` which comes from `resolvePlanPathContext(config)` in `src/tim/path_resolver.ts`.

#### 7. Process tracking considerations

Once we spawn a detached process, we need to track it minimally:
- The process will register itself as a session via HeadlessAdapter
- The session will appear in the Sessions tab automatically
- No need for server-side process tracking beyond what the session system already provides
- If we want to prevent duplicate launches, we could check active sessions for a matching planId

#### 8. Relevant files and modules

**Files to create:**
- `src/routes/api/plans/[planUuid]/generate/+server.ts` — API endpoint to spawn the generate process

**Files to modify:**
- `src/lib/components/PlanDetail.svelte` — Add "Generate" button with eligibility logic
- `src/lib/server/session_routes.ts` — Potentially add shared helpers if needed (or keep new route self-contained)
- `src/lib/server/init.ts` — May need to expose `tasksDir` / `gitRoot` in server context

**Files to reference (read-only):**
- `src/tim/commands/generate.ts` — Understand what options to pass
- `src/tim/headless.ts` — Understand how sessions connect
- `src/tim/workspace/workspace_setup.ts` — Understand auto-workspace behavior
- `src/common/process.ts` — Understand spawn patterns
- `src/lib/server/ws_server.ts` — Understand session connection flow
- `src/lib/server/session_manager.ts` — Understand session tracking
- `src/lib/server/db_queries.ts` — Understand PlanDetail type
- `src/lib/server/plans_browser.ts` — Understand plan data loading

### Design Decisions

**Shell command vs. programmatic invocation**: Shell command (`tim generate <planId> --auto-workspace --non-interactive --no-terminal-input`) is the right approach. It's what the plan description asks for, it's maximally decoupled, and it naturally gets all the workspace setup, cleanup, and session management behavior.

**Detached process**: Use `Bun.spawn` with stdio detached from the parent. The process will manage its own lifecycle (workspace lock, cleanup handlers, etc.) independently of the web server.

**Session monitoring**: No custom tracking needed — the spawned process will connect via HeadlessAdapter to the WebSocket server and appear as a regular session. The user can monitor it in the Sessions tab.

**Duplicate prevention**: Check active sessions in the SessionManager for an existing generate session targeting the same planId before spawning a new one.

## Implementation Guide

### Expected Behavior/Outcome

When viewing a plan detail page for a stub plan (no tasks), the user sees a "Generate" button. Clicking it:
1. Spawns `tim generate <planId> --auto-workspace --non-interactive --no-terminal-input` as a detached process
2. Shows brief feedback that the process was started
3. The process appears as a new session in the Sessions tab within seconds
4. The user can monitor generation progress, respond to prompts, and see the final result through the existing session UI
5. If a generate process is already running for this plan, the button is disabled or shows appropriate state

**States:**
- **Eligible**: Plan has no tasks, status is not `done`/`cancelled`, no active generate session for this plan → "Generate" button shown and enabled
- **Ineligible**: Plan has tasks or is done/cancelled → button hidden or disabled with tooltip
- **Running**: Active generate session exists for this plan → button disabled, shows "Generating..." with link to session
- **Starting**: POST in flight → button disabled with spinner
- **Error**: Spawn failed → error message shown

### Key Findings

**Product & User Story**: As a tim web user viewing a plan that needs generation, I want to click a button to start the generate process without switching to the terminal, and then monitor it through the existing sessions UI.

**Design & UX Approach**: Minimal UI addition — a single button on the plan detail header area. No new pages or complex flows. Leverage the existing sessions infrastructure for monitoring.

**Technical Plan & Risks**:
- Risk: The `tim` CLI binary must be in PATH for the web server process. This should normally be the case since the web server is started from the same environment.
- Risk: Environment variables (especially `ANTHROPIC_API_KEY`) must be available to the spawned process. Since we inherit the web server's env, this should work.
- Risk: Process orphaning if something goes wrong — mitigated by workspace lock timeouts and the generate command's own cleanup handlers.

**Pragmatic Effort Estimate**: Small-medium feature. The core mechanism (spawn a detached CLI command) is simple. Most work is in the API route, UI button with state management, and testing.

### Acceptance Criteria

- [ ] User can click "Generate" on an eligible plan detail page and a `tim generate` process starts
- [ ] The spawned process appears as a session in the Sessions tab
- [ ] The spawned process survives web server restart (HMR in dev)
- [ ] The button is disabled/hidden for ineligible plans (has tasks, done, cancelled)
- [ ] The button shows appropriate state when generation is already running
- [ ] Duplicate generation for the same plan is prevented
- [ ] All new code paths are covered by tests

### Dependencies & Constraints

- **Dependencies**: Relies on the existing HeadlessAdapter/WebSocket session infrastructure, the `tim generate` CLI command, and the plan detail component.
- **Technical Constraints**: The `tim` binary must be accessible in the web server's PATH. The web server's environment must include required env vars (API keys). The primary workspace must be the git root where the web server runs.

### Implementation Notes

#### Step 1: Extend ServerContext with git root and tasks directory

Modify `src/lib/server/init.ts` to include `gitRoot` and `tasksDir` in the `ServerContext` interface. These are needed by the API route to resolve plan files and set the working directory for the spawned process.

Use `resolvePlanPathContext(config)` from `src/tim/path_resolver.ts` to get these values. This is the same function used by the CLI commands.

```
ServerContext { config, db, gitRoot, tasksDir }
```

#### Step 2: Create the API route for spawning generate

Create `src/routes/api/plans/[planUuid]/generate/+server.ts`.

The route handler should:
1. Look up the plan by UUID from the database to validate it exists and is eligible
2. Check active sessions in SessionManager for duplicate prevention (look for sessions with matching planId and command 'generate')
3. Resolve the plan's numeric ID (needed for the CLI command)
4. Spawn `tim generate <planId> --auto-workspace --non-interactive --no-terminal-input` as a detached process:
   - Use `Bun.spawn()` with `{ detached: true, stdio: ['ignore', 'ignore', 'ignore'] }` (or pipe stderr for error capture)
   - Set `cwd` to the git root from server context
   - Inherit environment from `process.env`
   - Call `.unref()` on the resulting process to fully detach it
5. Return success with a brief status message

For the spawn, use `Bun.spawn` directly (not the wrapper in `src/common/process.ts`) since we want different behavior (detached, no output processing).

For duplicate detection, iterate `getSessionManager().getSessionSnapshot()` and check for active sessions where `sessionInfo.command === 'generate'` and `sessionInfo.planId === planId`.

#### Step 3: Add "Generate" button to PlanDetail component

Modify `src/lib/components/PlanDetail.svelte` to add a "Generate" button in the header area (next to the status/priority badges).

Eligibility logic:
- `plan.tasks.length === 0` (stub plan)
- `plan.displayStatus !== 'done' && plan.displayStatus !== 'cancelled'`

The button should:
- POST to `/api/plans/${plan.uuid}/generate`
- Show loading state while the request is in flight
- Show success/error feedback
- Optionally include a link to navigate to sessions tab

For detecting "already running" state, the simplest approach is to let the API route return a specific response (e.g., 409 Conflict) if a generate session already exists, and handle that in the UI.

#### Step 4: Add duplicate-detection helper to SessionManager

Add a method to `src/lib/server/session_manager.ts`:

```typescript
hasActiveSessionForPlan(planId: number, command: string): boolean
```

This iterates active sessions and checks `session.sessionInfo?.planId === planId && session.sessionInfo?.command === command && session.status === 'active'`.

#### Step 5: Write tests

- **API route test**: Test the POST endpoint with valid/invalid plan UUIDs, already-running detection, and successful spawn. Mock `Bun.spawn` to avoid actually spawning processes.
- **SessionManager test**: Test the `hasActiveSessionForPlan` helper.
- **Component test**: If there are existing component test patterns, add a test for the Generate button's visibility/state logic. Otherwise, cover the eligibility logic in a unit test.

#### Step 6: Manual testing

1. Start the web server (`bun run dev`)
2. Navigate to a stub plan's detail page
3. Click "Generate" — verify process spawns and appears in Sessions tab
4. Verify the button is disabled for plans with tasks
5. Kill and restart the web server — verify the generate process continues running
6. Verify the session reconnects after server restart

### Potential Gotchas

- **`tim` binary location**: The spawn needs to find `tim`. If installed globally via npm/bun, it should be in PATH. If running from the repo, may need to use `bunx` or the full path. Need to determine the right command to use.
- **Config path**: The spawned `tim generate` needs to find the right config. It uses `loadEffectiveConfig()` which reads from the XDG config directory. This should work automatically since env vars are inherited.
- **Non-interactive mode**: The `--non-interactive` flag skips all user prompts. Need to ensure the generate command handles this gracefully (e.g., auto-selecting defaults for workspace creation).
- **Workspace locking**: The auto-workspace selection may create a new workspace if all are locked. This is fine — it's the expected behavior.
- **Process cleanup on error**: If the spawn itself fails (command not found, etc.), need to handle this gracefully and return an error to the client.
