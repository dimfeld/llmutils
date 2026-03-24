---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Add activity_log table and emit events from state transitions
goal: "Add a lightweight activity_log table to the SQLite DB and emit events from key state transitions (plan status changes, agent start/finish, PR status changes, workspace lock/unlock) so the new dashboard has persistent history to display."
id: 265
uuid: 428ed935-e91e-4d20-a4cb-46947ee8b2aa
status: pending
priority: high
parent: 264
references:
  "264": 80611f4c-32a4-4b3b-90c2-4e7e35cc519b
createdAt: 2026-03-24T19:15:14.569Z
updatedAt: 2026-03-24T19:15:14.576Z
tasks: []
tags: []
---

## Details

### activity_log table schema

Table: `activity_log`
- `id` INTEGER PRIMARY KEY
- `timestamp` TEXT NOT NULL (ISO-8601 UTC)
- `event_type` TEXT NOT NULL — e.g. `plan_status_changed`, `agent_started`, `agent_finished`, `pr_status_changed`, `pr_merged`, `workspace_locked`, `workspace_unlocked`, `plan_created`, `task_completed`
- `project_id` INTEGER (nullable, FK to project)
- `plan_id` INTEGER (nullable — the plan number, not UUID)
- `plan_uuid` TEXT (nullable)
- `workspace_id` INTEGER (nullable)
- `session_id` TEXT (nullable — for agent session events)
- `summary` TEXT NOT NULL — human-readable one-liner, e.g. "Plan #42 moved to in_progress", "Agent finished: 3/5 tasks done"
- `metadata` TEXT (nullable — JSON blob for extra structured data like old/new status, PR URL, etc.)

Index on `(project_id, timestamp DESC)` for efficient feed queries. Index on `(plan_id, timestamp DESC)` for plan-scoped activity.

### Emit points

1. **Plan status changes** — in `syncPlanToDb()` or `writePlanFile()`, detect when status differs from DB and log the transition
2. **Agent session start/finish** — in session connect/disconnect handlers in `session_manager.ts` or `session_discovery.ts`
3. **PR status changes** — in `refreshPrStatus()` when state, review decision, or check rollup changes
4. **Workspace lock/unlock** — in `WorkspaceLock.acquireLock()` and `releaseLock()`
5. **Task completion** — when tasks are marked done via CLI or MCP tools
6. **Plan creation** — in `tim add` flow

### API for the web UI

Add a `getActivityFeed(db, projectId, { limit, before })` query function in `db_queries.ts` that returns recent events with cursor-based pagination.
