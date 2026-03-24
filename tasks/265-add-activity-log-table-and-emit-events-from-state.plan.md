---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Add activity_log table and emit events from state transitions
goal: Add a lightweight activity_log table to the SQLite DB and emit events from
  key state transitions (plan status changes, agent start/finish, PR status
  changes, workspace lock/unlock) so the new dashboard has persistent history to
  display.
id: 265
uuid: 428ed935-e91e-4d20-a4cb-46947ee8b2aa
generatedBy: agent
status: pending
priority: high
parent: 264
references:
  "264": 80611f4c-32a4-4b3b-90c2-4e7e35cc519b
planGeneratedAt: 2026-03-24T20:18:20.727Z
promptsGeneratedAt: 2026-03-24T20:18:20.727Z
createdAt: 2026-03-24T19:15:14.569Z
updatedAt: 2026-03-24T20:18:20.728Z
tasks:
  - title: Add migration v9 and create activity_log DB module
    done: false
    description: "Add migration v9 in src/tim/db/migrations.ts creating the
      activity_log table (id, timestamp, event_type, project_id FK with ON
      DELETE SET NULL, plan_id, plan_uuid, workspace_id, session_id, metadata).
      No summary column. Add indexes on (project_id, timestamp DESC) and
      (plan_id, timestamp DESC). Create src/tim/db/activity_log.ts with:
      ActivityEventType union type, typed metadata interfaces per event type,
      ActivityLogRow interface, LogActivityInput interface, logActivity(db,
      input) synchronous INSERT function (no transaction wrapper),
      getActivityFeed(db, options) query function with cursor-based pagination
      (WHERE timestamp < before, ORDER BY timestamp DESC, LIMIT). Write tests in
      src/tim/db/activity_log.test.ts covering logActivity with all field
      combinations, getActivityFeed with project/plan filters, cursor
      pagination, and ordering."
  - title: Emit plan status changes, task completions, and plan creation from
      upsertPlan()
    done: false
    description: "In src/tim/db/plan.ts upsertPlan(), after reading existing row
      (line 160) and after the INSERT/UPDATE + task replacement: (1) If existing
      is null, logActivity with plan_created and metadata {title, priority}. (2)
      If existing exists and status changed, logActivity with
      plan_status_changed and metadata {oldStatus, newStatus}. Skip if
      old===new. (3) For task completion: read old tasks via getPlanTasksByUuid
      before replacePlanTasks, compare done counts, log individual
      task_completed events per newly-done task with metadata {taskTitle,
      taskIndex, doneTasks, totalTasks}. All within existing transaction. Add
      tests verifying: plan creation event, status change event, no event on
      same-status re-sync, individual task completion events, multiple tasks
      completed in one sync."
  - title: Emit agent/generate session events from CLI commands
    done: false
    description: 'In src/tim/commands/agent/agent.ts: after workspace setup and
      before executor runs, call logActivity with agent_started (metadata:
      {command: "agent", executor, mode}). After executor completes, call
      logActivity with agent_finished (metadata: {command: "agent", success,
      durationMs, summary}). Resolve project_id from workspace/git context. Same
      pattern in src/tim/commands/generate.ts with command: "generate". Both
      commands already have DB access via getDatabase(). Add tests verifying
      start/finish events are logged with correct metadata for both agent and
      generate commands.'
  - title: Emit PR status change events from pr_status_service.ts
    done: false
    description: 'In src/common/github/pr_status_service.ts refreshPrStatus():
      before upsertPrStatus(), read existing state via getPrStatusByUrl(). After
      upsert, compare old vs new for state, reviewDecision, mergedAt. Log
      pr_merged if mergedAt became non-null (metadata: {prUrl, mergedAt}). Log
      pr_status_changed for state changes (metadata: {prUrl, field: "state",
      oldValue, newValue}) and reviewDecision changes (metadata: {prUrl, field:
      "reviewDecision", oldValue, newValue}). In refreshPrCheckStatus(): capture
      old check_rollup_state, log pr_status_changed if changed. Resolve plan
      associations via plan_pr junction + plan.project_id. Log one event per
      affected plan. Add helper to find plan associations for a PR URL. Add
      tests for state transitions, review changes, merge events, and per-plan
      event logging.'
  - title: Emit workspace lock/unlock events from WorkspaceLock class
    done: false
    description: "In src/tim/workspace/workspace_lock.ts acquireLock(): after
      successful DB lock acquisition, call logActivity with workspace_locked.
      The workspace ID and project_id are available from the workspace lookup
      (getOrCreateWorkspaceId resolves the workspace row). Metadata: {lockType,
      pid, hostname, command}. In releaseLock(): read lock metadata before DB
      release, then after successful release call logActivity with
      workspace_unlocked. Metadata: {lockType}. Pass project_id from the
      workspace row. Add tests verifying lock/unlock events are logged with
      correct workspace and project associations."
  - title: Wire up getActivityFeed for the web UI
    done: false
    description: In src/lib/server/db_queries.ts, re-export or wrap
      getActivityFeed() from the activity_log module so it is available to route
      handlers. This makes the query function accessible for plan 267 (activity
      feed UI). Verify the import works from the web server context using the
      $tim alias.
tags: []
---

## Details

### activity_log table schema

Table: `activity_log`
- `id` INTEGER PRIMARY KEY
- `timestamp` TEXT NOT NULL (ISO-8601 UTC)
- `event_type` TEXT NOT NULL — e.g. `plan_status_changed`, `agent_started`, `agent_finished`, `pr_status_changed`, `pr_merged`, `workspace_locked`, `workspace_unlocked`, `plan_created`, `task_completed`
- `project_id` INTEGER (nullable, FK to project with ON DELETE SET NULL)
- `plan_id` INTEGER (nullable — the plan number, not UUID; not FK'd to preserve history after plan deletion)
- `plan_uuid` TEXT (nullable)
- `workspace_id` INTEGER (nullable; not FK'd to preserve history after workspace deletion)
- `session_id` TEXT (nullable — for agent session events)
- `metadata` TEXT (nullable — JSON blob with typed structure per event_type; UI derives display text from event_type + metadata)

Index on `(project_id, timestamp DESC)` for efficient feed queries. Index on `(plan_id, timestamp DESC)` for plan-scoped activity.

### Metadata shapes per event type

- `plan_status_changed`: `{ oldStatus: string, newStatus: string }`
- `plan_created`: `{ title: string, priority?: string }`
- `task_completed`: `{ taskTitle: string, taskIndex: number, doneTasks: number, totalTasks: number }`
- `agent_started`: `{ command: 'agent' | 'generate', executor: string, mode?: string }`
- `agent_finished`: `{ command: 'agent' | 'generate', success: boolean, durationMs?: number, summary?: string }`
- `pr_status_changed`: `{ prUrl: string, field: string, oldValue: string, newValue: string }`
- `pr_merged`: `{ prUrl: string, mergedAt: string }`
- `workspace_locked`: `{ lockType: string, pid: number, hostname: string, command: string }`
- `workspace_unlocked`: `{ lockType: string }`

### Emit points

All events are emitted from CLI/shared code (not the web server) to ensure completeness regardless of whether the web UI is running. The DB is shared via WAL mode, so CLI-emitted events are visible to the web UI.

1. **Plan status changes** — in `upsertPlan()` in `src/tim/db/plan.ts`, detect when status differs from existing DB row and log the transition
2. **Plan creation** — in `upsertPlan()` when `existing === null` (first insert)
3. **Task completion** — in `upsertPlan()` by comparing old vs new task done counts
4. **Agent/generate session start/finish** — in `src/tim/commands/agent/agent.ts` and `src/tim/commands/generate.ts`, using shared `agent_started`/`agent_finished` event types with `command` field in metadata to distinguish
5. **PR status changes** — in `refreshPrStatus()` and `refreshPrCheckStatus()` in `src/common/github/pr_status_service.ts`, capturing old state before upsert to detect transitions. One event per affected plan (via `plan_pr` junction).
6. **Workspace lock/unlock** — in the higher-level `WorkspaceLock` class in `src/tim/workspace/workspace_lock.ts` (not the DB-level functions), where `project_id` is passed in from the caller

### API for the web UI

Add a `getActivityFeed(db, projectId, { limit, before })` query function in `db_queries.ts` that returns recent events with cursor-based pagination.

## Expected Behavior/Outcome

After implementation, every key state transition in the tim system will produce a persistent record in the `activity_log` table. The web dashboard (plan 267) will be able to query this table to show a chronological activity feed per project or per plan. Events include plan status changes, agent session lifecycle, PR status transitions, workspace lock/unlock, task completion, and plan creation.

### Relevant States

- **Event types**: `plan_status_changed`, `plan_created`, `task_completed`, `agent_started`, `agent_finished`, `pr_status_changed`, `pr_merged`, `workspace_locked`, `workspace_unlocked`
- **Each event** has: timestamp, event_type, optional project/plan/workspace/session associations, and typed JSON metadata. The UI derives display text from event_type + metadata (no summary column).

## Key Findings

### Product & User Story
As a developer managing multiple concurrent plans and agents, I want to see a timeline of what happened (plan moved to in_progress, agent finished with 3/5 tasks done, PR checks passed) so I can quickly understand current status and decide what to do next. This activity log is the data backbone for the dashboard activity feed (plan 267).

### Design & UX Approach
This plan is purely backend/data-layer — no UI components. The output is a query API (`getActivityFeed`) that the activity feed UI (plan 267) will consume. Events store typed JSON metadata per event type; the UI derives all display text from `event_type` + `metadata` (no precomputed summary column).

### Technical Plan & Risks
- **Central choke point**: All plan file changes flow through `writePlanFile()` → `syncPlanToDb()` → `upsertPlan()`. Status change detection belongs in `upsertPlan()` where we have both old and new values within the same transaction.
- **Task completion detection**: Task done counts change during `upsertPlan()` when tasks are replaced. We can compare old vs new task arrays to detect completions.
- **Agent sessions**: Emitted from `agent.ts` and `generate.ts` command entry points (CLI side), not from the web UI's SessionManager. This ensures events are logged regardless of whether the web UI is running. Both use shared `agent_started`/`agent_finished` event types with a `command` field to distinguish.
- **PR status**: `refreshPrStatus()` and `refreshPrCheckStatus()` in `pr_status_service.ts` are the mutation points. We need to capture old state before upsert to detect transitions. One event per affected plan (via `plan_pr` junction).
- **Workspace locks**: Emitted from the higher-level `WorkspaceLock` class in `src/tim/workspace/workspace_lock.ts`, not the DB-level functions. The caller passes `project_id` in.
- **Risk: High-frequency events**: `syncPlanToDb()` runs on every plan file write. If a generate/agent session updates the plan file frequently (task completions, changed files), we could get many log entries. The plan specifies logging only status changes and task completions, not every file write, which limits volume.

### Pragmatic Effort Estimate
Medium scope. The migration and CRUD module are straightforward. The bulk of the work is threading activity log calls through ~6 different emit points, each requiring understanding of the surrounding context to extract the right data. Testing requires setting up scenarios for each emit point.

## Acceptance Criteria

- [ ] Migration v9 creates `activity_log` table with proper schema, indexes, and foreign keys
- [ ] `logActivity()` helper function exists in a new `src/tim/db/activity_log.ts` module
- [ ] Plan status changes (pending→in_progress, in_progress→done, etc.) produce activity log entries with old/new status in metadata
- [ ] Plan creation via `tim add` produces a `plan_created` event
- [ ] Task completion produces `task_completed` events with task title and done/total counts
- [ ] Agent/generate session start/finish produces events from `agent.ts` and `generate.ts` CLI commands
- [ ] PR status changes (state transitions, review decision changes, merge) produce events
- [ ] Workspace lock/unlock produces events
- [ ] `getActivityFeed()` query function supports project-scoped and plan-scoped queries with cursor pagination
- [ ] All new code paths are covered by tests
- [ ] Existing tests continue to pass (activity logging is additive, not breaking)

## Dependencies & Constraints

- **Dependencies**: Relies on existing migration system (v1-v8), `upsertPlan()` transaction pattern, `agent.ts`/`generate.ts` command entry points, `pr_status_service.ts` refresh functions, `WorkspaceLock` class
- **Technical Constraints**: All DB operations are synchronous (bun:sqlite). Activity log inserts in transaction-wrapped functions must also be synchronous. The shared DB file (WAL mode) allows CLI and web processes to write concurrently without conflicts.
- **Sibling plan dependency**: Plan 267 (activity feed UI) depends on the `getActivityFeed()` query function from this plan

## Implementation Notes

### Recommended Approach

Create a standalone `src/tim/db/activity_log.ts` module with a simple `logActivity(db, event)` function. This keeps activity logging decoupled — emit points just call `logActivity()` with the relevant data. The function handles the INSERT synchronously.

All events are emitted from CLI/shared code, not from the web server. This ensures completeness regardless of whether the web UI is running. The DB is shared via WAL mode.

For status change detection in `upsertPlan()`, read the existing plan row (already done for timestamp comparison) and compare `status` field before/after. Similarly for task completion, compare old vs new task done counts.

For PR status changes, capture old state before the upsert call in `refreshPrStatus()` and compare after.

For agent/generate events, emit from `agent.ts` and `generate.ts` command entry points directly.

For workspace lock/unlock, emit from the higher-level `WorkspaceLock` class with project_id passed in from callers.

No `summary` column — the UI derives display text from `event_type` + `metadata`. No cleanup/retention mechanism.

### Potential Gotchas

1. **Transaction scope**: When adding `logActivity()` inside `upsertPlan()`, it's already within a transaction — no need for a nested transaction. But when calling from `refreshPrStatus()` (which isn't in a transaction), the log insert needs its own write.
2. **Plan ID vs UUID**: The schema uses both `plan_id` (human-readable number) and `plan_uuid`. Both should be stored for flexibility — plan_id for display, plan_uuid for linking.
3. **`syncAllPlansToDb()` bulk sync**: This runs on startup and could generate many `plan_created` events for plans that haven't been seen before. This is acceptable — it's a one-time thing. But skip logging `plan_status_changed` when old and new status are identical.
4. **PR events per plan**: A single PR can be linked to multiple plans. Log one event per affected plan so the activity feed filters correctly per-project and per-plan.

## Research

### Database Layer Architecture

The database uses bun:sqlite with synchronous operations. Migrations are sequential (v1-v8 currently) defined in `src/tim/db/migrations.ts`. Each migration has a version number and an `up` SQL string. The `runMigrations()` function runs all pending migrations in a single `db.transaction().immediate()` call. The next migration will be version 9.

Key patterns:
- `SQL_NOW_ISO_UTC` from `src/tim/db/sql_utils.ts` generates ISO-8601 timestamps: `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
- All write transactions use `db.transaction().immediate()`
- CRUD modules follow a consistent pattern: row types, input types, upsert/query/delete functions
- Foreign keys are enforced (`PRAGMA foreign_keys = ON`)

### Plan Sync Flow (the critical path for status change detection)

All plan file modifications flow through:
1. Caller modifies plan data in memory
2. `writePlanFile(filePath, plan)` in `src/tim/plans.ts` (line ~740) writes YAML to disk
3. `writePlanFile` always calls `syncPlanToDb(plan, filePath, { force: true })`
4. `syncPlanToDb()` in `src/tim/db/plan_sync.ts` resolves project context and calls `upsertPlan()`
5. `upsertPlan()` in `src/tim/db/plan.ts` (line 157-263) does INSERT OR CONFLICT UPDATE within a transaction

**Inside `upsertPlan()` (the ideal intercept point for status changes):**
- Line 160: `const existing = getPlanByUuid(db, nextInput.uuid)` — reads current DB state
- This gives us the old status and old task state
- After the INSERT/UPDATE (line 178-247), we can compare old vs new
- We're already inside `db.transaction().immediate()`, so activity log inserts are atomic

### Task Completion Paths

Tasks are marked done through several paths, all ultimately calling `writePlanFile()`:

1. **CLI `tim done`** → `markStepDone()` in `src/tim/plans/mark_done.ts` → `writePlanFile()`
2. **CLI `tim set-task-done`** → `setTaskDone()` in `src/tim/plans/mark_done.ts` → `writePlanFile()`
3. **MCP tool `manage-plan-task`** → `managePlanTaskTool()` in `src/tim/tools/manage_plan_task.ts` → `writePlanFile()`
4. **Agent executors** (codex_cli) → `task_management.ts` → various mark_done functions → `writePlanFile()`

Since all paths go through `writePlanFile()` → `syncPlanToDb()` → `upsertPlan()`, detecting task completion inside `upsertPlan()` catches all cases.

### Plan Creation Path

`tim add` in `src/tim/commands/add.ts`:
- Creates new plan data (line 116-139)
- Calls `writePlanFile()` (line 240) for the new plan
- This triggers `syncPlanToDb()` → `upsertPlan()` where `existing` will be null (first insert)
- When `existing === null`, we know it's a plan creation event

### Agent/Generate Session Lifecycle

Agent and generate commands are separate CLI entry points:
- `src/tim/commands/agent/agent.ts` — `handleAgentCommand()` orchestrates executor, workspace setup, plan context
- `src/tim/commands/generate.ts` — `handleGenerateCommand()` similar pattern for generation
- Both use `setupWorkspace()` for workspace management and have access to plan data (planId, planUuid, title) and can resolve project_id from the workspace/git context
- Both already have access to `getDatabase()` for DB operations
- The natural emit points are: right after workspace setup (start event) and after executor completes (finish event with success/failure)
- Use shared `agent_started`/`agent_finished` event types with a `command: 'agent' | 'generate'` field in metadata

### PR Status Changes

`src/common/github/pr_status_service.ts`:
- `refreshPrStatus()` calls `upsertPrStatus()` which atomically replaces all PR data
- To detect changes, we need to read old state before the upsert: `getPrStatusByUrl(db, prUrl)`
- Key transitions to log: state changes (open→merged, open→closed), review decision changes, check rollup state changes
- `refreshPrCheckStatus()` only updates check runs — should log when `check_rollup_state` changes

### Workspace Lock/Unlock

Two levels of workspace lock management:
- `src/tim/db/workspace_lock.ts` — low-level DB functions: `acquireWorkspaceLock()`, `releaseWorkspaceLock()`. Synchronous, within transactions. Takes workspace_id.
- `src/tim/workspace/workspace_lock.ts` — higher-level `WorkspaceLock` class. Maps workspace path → workspace ID, manages process lifecycle cleanup handlers, has `getOrCreateWorkspaceId()` which resolves workspace row (including project_id).
- Activity log events should be emitted from the higher-level class where project_id is available, not from the DB-level functions.

### Web UI Query Layer

`src/lib/server/db_queries.ts` contains enriched query functions that the web routes consume:
- All functions are synchronous (bun:sqlite)
- Pattern: `db.prepare(...).all()` / `.get()` with typed results
- `getPlansForProject()`, `getPlanDetail()`, `getWorkspacesForProject()` etc.
- The new `getActivityFeed()` function should follow the same patterns
- Cursor-based pagination: use `timestamp < ?` with ORDER BY timestamp DESC, LIMIT N

### Existing Test Patterns

Tests use Bun's test runner. DB tests typically:
- Call `openDatabase(':memory:')` or create temp directories with fixture files
- Set up test data with direct DB inserts or via the CRUD functions
- Assert on query results
- The `mark_done.test.ts` file creates temp plan files and verifies behavior

## Implementation Guide

### Step 1: Add migration v9 and create the activity_log DB module

In `src/tim/db/migrations.ts`, add migration version 9:

```sql
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_type TEXT NOT NULL,
  project_id INTEGER REFERENCES project(id) ON DELETE SET NULL,
  plan_id INTEGER,
  plan_uuid TEXT,
  workspace_id INTEGER,
  session_id TEXT,
  metadata TEXT
);
CREATE INDEX idx_activity_log_project_timestamp ON activity_log(project_id, timestamp DESC);
CREATE INDEX idx_activity_log_plan_timestamp ON activity_log(plan_id, timestamp DESC);
```

No `summary` column — the UI derives display text from `event_type` + `metadata`. Use `ON DELETE SET NULL` for project_id FK so deleting a project doesn't cascade-delete activity history. plan_id and workspace_id are not FK'd to preserve history after deletion.

Create `src/tim/db/activity_log.ts` with:

1. **Type definitions**:
   - `ActivityLogRow` interface matching the table columns
   - `LogActivityInput` interface for the `logActivity()` function parameter
   - `ActivityEventType` string literal union: `'plan_status_changed' | 'plan_created' | 'task_completed' | 'agent_started' | 'agent_finished' | 'pr_status_changed' | 'pr_merged' | 'workspace_locked' | 'workspace_unlocked'`
   - Typed metadata interfaces per event type (e.g., `PlanStatusChangedMetadata`, `TaskCompletedMetadata`, etc.)

2. **`logActivity(db, input)` function**:
   - Simple synchronous INSERT into `activity_log`
   - Uses `SQL_NOW_ISO_UTC` for timestamp if not provided
   - Accepts all nullable FK fields (project_id, plan_id, plan_uuid, workspace_id, session_id)
   - JSON.stringify the metadata object
   - No transaction wrapper — callers in transactions will inherit their transaction; standalone callers get autocommit

3. **`getActivityFeed(db, options)` function**:
   - Parameters: `{ projectId?: number, planId?: number, planUuid?: string, limit?: number, before?: string }`
   - Returns `ActivityLogRow[]` ordered by timestamp DESC
   - Cursor pagination via `WHERE timestamp < ?` when `before` is provided
   - Default limit of 50
   - Build query dynamically based on which filter params are provided

Write tests in `src/tim/db/activity_log.test.ts`:
- Test `logActivity()` inserts correctly with all field combinations
- Test `getActivityFeed()` with project filter, plan filter, pagination
- Test cursor-based pagination (before parameter)
- Test ordering (newest first)

### Step 2: Emit plan status changes, task completions, and plan creation from upsertPlan()

In `src/tim/db/plan.ts`, modify `upsertPlan()`:

1. After reading `existing` (line 160), capture `existing?.status` and existing task list (via `getPlanTasksByUuid`)
2. After the INSERT/UPDATE and task replacement (line 249-251):
   - If `existing` is null, call `logActivity()` with `event_type: 'plan_created'`, metadata: `{ title, priority }`
   - If `existing` exists and `existing.status !== input.status` and `input.status` is defined, call `logActivity()` with `event_type: 'plan_status_changed'`, metadata: `{ oldStatus, newStatus }`
   - For task completion: compare old task done count vs new tasks. For each newly-done task (was `done=0`, now `done=1`), log individual `task_completed` events with metadata: `{ taskTitle, taskIndex, doneTasks, totalTasks }`

This is all within the existing transaction, so it's atomic. The `logActivity()` calls are simple INSERTs that participate in the transaction.

Add tests to verify:
- Plan creation generates `plan_created` event
- Status change generates `plan_status_changed` with correct old/new
- Same status on re-sync does NOT generate an event
- Task completion generates individual `task_completed` events
- Multiple tasks completed in one sync each get their own event

### Step 3: Emit agent/generate session events from CLI commands

In `src/tim/commands/agent/agent.ts`:
- At session start (after workspace setup, before executor runs), call `logActivity()` with `agent_started`
- Need to resolve project_id from the workspace/git context
- Metadata: `{ command: 'agent', executor, mode }`
- At session end (after executor completes), call `logActivity()` with `agent_finished`
- Metadata: `{ command: 'agent', success, durationMs, summary }`

In `src/tim/commands/generate.ts`:
- Same pattern but with `command: 'generate'` in metadata
- At start: `logActivity()` with `agent_started`, metadata `{ command: 'generate', executor }`
- At end: `logActivity()` with `agent_finished`, metadata `{ command: 'generate', success, durationMs }`

Both commands already have access to the DB (via `getDatabase()`) and plan context.

Add tests to verify agent start/finish events are logged with correct metadata.

### Step 4: Emit PR status change events from pr_status_service.ts

In `src/common/github/pr_status_service.ts`:

1. In `refreshPrStatus()`:
   - Before the `upsertPrStatus()` call, read existing state: `getPrStatusByUrl(db, canonicalPrUrl)`
   - After upsert, compare old vs new: state, reviewDecision, mergedAt
   - If state changed to 'merged' (mergedAt became non-null), log `pr_merged` with metadata `{ prUrl, mergedAt }`
   - If state changed (open→closed, etc.), log `pr_status_changed` with metadata `{ prUrl, field: 'state', oldValue, newValue }`
   - If reviewDecision changed, log `pr_status_changed` with metadata `{ prUrl, field: 'reviewDecision', oldValue, newValue }`
   - Resolve plan associations via `plan_pr` junction table. Log one event per affected plan with that plan's project_id, plan_id, plan_uuid.

2. In `refreshPrCheckStatus()`:
   - Before `updatePrCheckRuns()`, capture old `check_rollup_state` from existing detail
   - After update, if rollup state changed, log `pr_status_changed` with metadata `{ prUrl, field: 'checkRollupState', oldValue, newValue }`
   - Same per-plan event logging as above

Helper function to find plan associations for a PR: query `plan_pr` join `plan` to get `(plan_id, plan_uuid, project_id)` for each linked plan.

Add tests to verify PR state transitions, review changes, and merge events are logged correctly.

### Step 5: Emit workspace lock/unlock events from WorkspaceLock class

In `src/tim/workspace/workspace_lock.ts`:

1. In `acquireLock()`:
   - After successful DB lock acquisition, call `logActivity()` with `workspace_locked`
   - The workspace ID and project_id are available from the workspace lookup
   - Metadata: `{ lockType, pid, hostname, command }`

2. In `releaseLock()`:
   - After successful DB lock release, call `logActivity()` with `workspace_unlocked`
   - Read lock metadata before release to populate the event
   - Metadata: `{ lockType }`

Add tests to verify lock/unlock events are logged with correct workspace and project associations.

### Step 6: Wire up getActivityFeed for the web UI

In `src/lib/server/db_queries.ts`:
- Re-export or wrap `getActivityFeed()` from the activity_log module
- This makes it available to route handlers for plan 267

### Manual Testing Steps

1. Run `tim add "Test plan"` and verify `activity_log` has a `plan_created` entry
2. Edit a plan file to change status, run `tim validate` or any command that triggers sync, verify `plan_status_changed` entry
3. Run `tim done` on a plan with tasks, verify both `task_completed` and (if all done) `plan_status_changed` entries
4. Run `tim agent` or `tim generate`, verify `agent_started` and `agent_finished` entries
5. Lock/unlock a workspace and verify entries
6. Query `getActivityFeed()` with different filters and verify pagination works
