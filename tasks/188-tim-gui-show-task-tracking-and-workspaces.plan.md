---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: show task tracking and workspaces"
goal: Add a new Projects view in tim-gui that reads tim.db and shows projects,
  workspaces, and plan-level task tracking with default filters for pending,
  in-progress, dependency-blocked, and recently-done (7 days) plans.
id: 188
uuid: 2f287626-23b9-4d02-9e15-983f6ba6d5fd
generatedBy: agent
status: done
priority: medium
dependencies:
  - 184
references:
  "184": 05e31645-305d-4e59-8c49-a9fbc9ce0bd7
planGeneratedAt: 2026-02-24T09:24:05.371Z
promptsGeneratedAt: 2026-02-24T09:24:05.371Z
createdAt: 2026-02-13T21:10:34.013Z
updatedAt: 2026-02-24T20:07:31.580Z
tasks:
  - title: Create project-tracking domain models and filter semantics
    done: true
    description: "Add a new Swift model file for project/workspace/plan tracking
      rows and filter state enums. Define canonical mapping for visible states:
      pending and in-progress from plan.status, blocked from unresolved
      plan_dependency rows (dependency plan status != done), and recently-done
      from plan.status=done with updated_at in the last 7 days. Keep this logic
      in pure helper functions so it is testable independently from UI and
      SQLite wiring."
  - title: Implement SQLite-backed ProjectTrackingStore with tim.db path resolution
    done: true
    description: Add a store that opens and reads tim.db in read-only mode, with
      injectable DB path for tests. Mirror tim CLI path conventions
      (XDG_CONFIG_HOME/APPDATA/home config root + tim.db filename behavior).
      Implement SQL queries to load projects, associated workspaces, plan rows,
      and dependency relationships needed for blocked-state derivation. Add
      robust error handling for missing DB, unreadable DB, and busy/locked
      reads.
  - title: Add refresh lifecycle and state management for project tracking
    done: true
    description: Extend the store with explicit loading/loaded-empty/loaded/error
      states and a refresh pipeline that performs initial load plus periodic
      refresh while the Projects view is active. Coalesce refreshes to avoid UI
      churn under frequent DB updates, and keep all published state updates on
      MainActor.
  - title: Build new ProjectsView UI with project, workspace, and plan-tracking panes
    done: true
    description: Create a new SwiftUI view that presents projects and their
      workspaces plus plan-level task tracking. Reuse existing empty-state and
      list conventions from SessionsView where practical. Show filter controls
      with default active filters (pending, in-progress, blocked, recently done)
      and a clear affordance to show all statuses. Include workspace metadata
      (primary/locked/available) and plan status/timestamp context in the detail
      area.
  - title: Integrate top-level view switching without regressing sessions
    done: true
    description: "Update ContentView and app wiring to support two top-level
      destinations: existing Sessions and new Projects. Ensure
      SessionState/websocket behavior remains unchanged when switching views and
      that the new ProjectTrackingStore is initialized and injected in
      TimGUIApp."
  - title: Add automated tests for SQLite projection and filter behavior
    done: true
    description: "Create tests using temporary SQLite fixtures that validate:
      project/workspace/plan loading, dependency-blocked derivation,
      recently-done 7-day window behavior, and default filter
      inclusion/exclusion rules. Add failure-mode tests for missing DB path,
      malformed/unexpected rows, and transient DB read errors. Prefer real
      queries over heavy mocks."
  - title: Add UI/state tests for Projects view rendering paths
    done: true
    description: Add tests that verify Projects view behavior across loading, empty,
      data, and error states using store-driven state. Validate that default
      filter presentation matches behavior and that expanding to all statuses
      reveals hidden rows. Keep tests deterministic and aligned with existing
      TimGUITests patterns.
  - title: Update documentation for the new Projects view
    done: true
    description: Update README and/or tim-gui docs to describe the Projects view,
      where data comes from (tim.db), default filter semantics (including
      dependency-blocked and recently-done 7-day rules), and any operational
      caveats around database availability.
  - title: "Address Review Feedback: Refresh coalescing drops user-initiated project
      reloads and can display stale data for the wrong selected project."
    done: true
    description: >-
      Refresh coalescing drops user-initiated project reloads and can display
      stale data for the wrong selected project. `selectProject(id:)` updates
      `selectedProjectId` and enqueues `refresh()`, but `refresh()` immediately
      returns if `isRefreshing` is true. If selection changes while an earlier
      refresh is mid-flight (after it has captured the previous `projectId`),
      the queued refresh is dropped and stale workspaces/plans are committed for
      the old project until the next 10s poll.


      Suggestion: Do not drop concurrent refresh requests. Add a `needsRefresh`
      flag (or generation token) so any refresh request arriving during an
      active load triggers an immediate follow-up refresh. Also validate that
      fetched project-specific data still matches the current
      `selectedProjectId` before assigning it.


      Related file: tim-gui/TimGUI/ProjectTrackingStore.swift:303-337
  - title: "Address Review Feedback: Default DB path resolution does not mirror the
      documented tim CLI behavior."
    done: true
    description: >-
      Default DB path resolution does not mirror the documented tim CLI
      behavior. It omits Windows `APPDATA` handling and treats an empty
      `XDG_CONFIG_HOME` as valid instead of falling back. The plan/acceptance
      criteria explicitly called out XDG/APPDATA/default-home conventions.


      Suggestion: Match `getTimConfigRoot()` semantics: handle Windows with
      `APPDATA` (or home fallback), trim and ignore empty `XDG_CONFIG_HOME`,
      then fall back to `~/.config/tim`.


      Related file: tim-gui/TimGUI/ProjectTrackingStore.swift:267-278
  - title: "Address Review Feedback: Critical new behavior is untested: refresh
      lifecycle/coalescing and DB path resolution semantics."
    done: true
    description: >-
      Critical new behavior is untested: refresh lifecycle/coalescing and DB
      path resolution semantics. There are no tests for `startRefreshing()`,
      `stopRefreshing()`, dropped-refresh behavior, or `resolveDefaultDBPath()`
      env/platform logic, which is why the stale-selection race and path
      convention drift were not caught.


      Suggestion: Add deterministic tests for: (1) selection changes during
      in-flight refresh, asserting a follow-up refresh occurs; (2) timer
      lifecycle start/stop; (3) path resolution with empty `XDG_CONFIG_HOME`,
      custom `TIM_DATABASE_FILENAME`, and platform-specific fallback behavior.


      Related file: tim-gui/TimGUITests/ProjectTrackingStoreTests.swift:1-949
  - title: "Address Review Feedback: Test schema diverges significantly from
      production schema."
    done: true
    description: >-
      Test schema diverges significantly from production schema. The real tim.db
      has project.id and workspace.id as INTEGER PRIMARY KEY AUTOINCREMENT, but
      the test createTestDatabase() creates them as TEXT PRIMARY KEY. The Swift
      model types (TrackedProject.id: String, TrackedWorkspace.id: String, etc.)
      reflect the test schema, not the real one. While SQLite type affinity
      makes this work at runtime (column_text on INTEGER returns string
      representation, bind_text with '1' compares correctly against INTEGER
      columns), the tests use non-representative data like 'proj-1' and 'ws-a'
      that can never appear in a real auto-incrementing integer column.
      Additional schema differences: plan.plan_id is INTEGER NOT NULL in
      production but nullable in tests; plan.filename is TEXT NOT NULL but
      nullable in tests; workspace_lock is missing required NOT NULL columns
      (lock_type, pid, started_at, hostname, command).


      Suggestion: Update the test schema to use INTEGER PRIMARY KEY
      AUTOINCREMENT for project.id and workspace.id (matching production), and
      adjust test data to use integer IDs. Consider using columnInt for
      integer-type columns in the Swift model and adding integer-typed ID
      fields, or at minimum document the deliberate type mapping choice.


      Related file: tim-gui/TimGUITests/ProjectTrackingStoreTests.swift:28-69
  - title: "Address Review Feedback: filteredPlans() and displayStatus() use Date()
      as default parameter values, meaning each call creates a new Date."
    done: true
    description: >-
      filteredPlans() and displayStatus() use Date() as default parameter
      values, meaning each call creates a new Date. In PlansSection.body,
      filteredPlans() at line 312 and displayStatus() at line 348 each call
      Date() independently. Different plans in the same render may be evaluated
      against slightly different times, and the filter result and individual
      status badges could theoretically disagree at the 7-day boundary.


      Suggestion: Create a single 'let now = Date()' at the top of
      PlansSection.body and pass it explicitly to both filteredPlans(now:) and
      displayStatus(for:now:).


      Related file: tim-gui/TimGUI/ProjectsView.swift:312,348
  - title: "Address Review Feedback: `sqlite3_step` return codes are not validated
      in the new store queries, so lock/error conditions can silently produce
      partial data while still setting `.loaded`."
    done: true
    description: >-
      `sqlite3_step` return codes are not validated in the new store queries, so
      lock/error conditions can silently produce partial data while still
      setting `.loaded`. In `doFetchProjects`, `doFetchWorkspaces`, and
      `doFetchPlansAndDeps`, loops stop on any non-`SQLITE_ROW` result and
      immediately return arrays without checking for `SQLITE_DONE`. If SQLite
      returns `SQLITE_BUSY`/`SQLITE_ERROR` after timeout, the UI can show
      truncated project/workspace/plan data instead of an error state. This
      violates the plan requirement to handle concurrent DB write/read
      conditions gracefully.


      Suggestion: Capture step result in a variable, continue on `SQLITE_ROW`,
      break on `SQLITE_DONE`, and throw `StoreError.queryFailed(...)` on any
      other code. Apply this pattern to all query loops.


      Related file: tim-gui/TimGUI/ProjectTrackingStore.swift:100,134,185,225
branch: full-ws main
changedFiles:
  - README.md
  - docs/multi-workspace-workflow.md
  - src/tim/commands/subagent.ts
  - tim-gui/AGENTS.md
  - tim-gui/TimGUI/ContentView.swift
  - tim-gui/TimGUI/ProjectTrackingModels.swift
  - tim-gui/TimGUI/ProjectTrackingStore.swift
  - tim-gui/TimGUI/ProjectsView.swift
  - tim-gui/TimGUI/TimGUIApp.swift
  - tim-gui/TimGUI.xcodeproj/project.pbxproj
  - tim-gui/TimGUITests/ProjectTrackingModelTests.swift
  - tim-gui/TimGUITests/ProjectTrackingStoreTests.swift
tags: []
---

We want to add the ability for tim-gui to list tasks and workspaces for each project. We should have two views in the
application, the existing one for sessions and the new one to view projects and their workspaces and tasks. The tasks
view should by default show only tasks that are pending, in progress, blocked, or recently done.

All data should come from the tim.db SQLite database.

## Research

### Overview

This feature adds a second major UI surface to `tim-gui`: a project/workspace/task explorer backed by `tim.db`, while preserving the existing real-time sessions UI. Today, `tim-gui` is entirely WebSocket/HTTP event-driven and has no persistent datastore integration. The plan therefore needs both product/UX shaping and foundational data-access work.

The feature intent is clear at a high level:
- Keep the current sessions view.
- Add a new view for projects, their workspaces, and task tracking.
- Default task filtering to active/near-active work.
- Source all data from SQLite (`tim.db`), not plan markdown scans.

### Key Findings

#### Product & User Story

- The app currently optimizes for live run monitoring, not repository-wide planning context.
- Users need to answer different questions than the sessions view supports:
  - What projects exist in my tim database?
  - Which workspaces exist for each project, and are they active/locked?
  - Which tasks/plans are currently actionable vs recently completed?
- The natural product model is two top-level destinations:
  - Sessions (existing)
  - Projects (new)
- Decision (confirmed): the Projects “tasks” list will represent plan-level work from the `plan` table.
- `plan_task` rows remain internal checklist data and are not the primary tracked units in this feature.
- `assignment.status` may enrich display but is not the canonical status source.

#### Design & UX Approach

- Existing UI patterns in `tim-gui` favor simple split views, sidebar lists, and explicit empty states (`SessionsView.swift`).
- The least disruptive architecture is top-level tab/segmented navigation:
  - tab 1: Sessions (unchanged behavior)
  - tab 2: Projects (new split view)
- Recommended Projects view layout:
  - Left pane: project list
  - Middle/secondary: workspace list for selected project
  - Detail pane: task list and filters for selected project
- Required UI states for each pane:
  - loading
  - loaded with data
  - empty
  - error
- Default filter behavior should be explicit and visible in UI (chips/toggles), with a “show all” affordance.

#### Technical Plan & Risks

- `tim-gui` currently has no database layer and no SQLite package integration.
- `tim.db` schema (from `src/tim/db/migrations.ts`) relevant tables:
  - `project`
  - `workspace`
  - `workspace_lock`
  - `assignment`
  - `plan`
  - `plan_task`
- Core risk: “pending/in progress/blocked/recently done” does not map directly to persisted DB fields today.
- Confirmed approach:
  - Treat “tasks” as plan-level rows (`plan`) with optional workspace/assignment enrichment.
  - Base status mapping on `plan.status` first, with explicit UI-level treatment for:
    - `pending` -> `plan.status = 'pending'`
    - `in_progress` -> `plan.status = 'in_progress'`
    - `blocked` -> derived when `plan_dependency` contains at least one dependency plan whose status is not `done`
    - `recently_done` -> `plan.status = 'done'` and `updated_at` within last 7 days
- Additional technical risks:
  - DB path resolution must mirror tim CLI conventions (`XDG_CONFIG_HOME/tim/tim.db`, Windows APPDATA behavior, optional filename override).
  - SQLite WAL reads must be handled robustly when tim is writing concurrently.
  - Refresh strategy must avoid UI jank (polling interval or file watcher debounce).
  - Large datasets need bounded query/sort/filter behavior in memory and SQL (indexes mostly exist, but UI still needs paging/limits if very large).

#### Pragmatic Effort Estimate

- Moderate scope, but cross-cutting in mac app:
  - new data layer
  - new state model
  - new complex view
  - tests for SQL projection/filter logic
- Estimated implementation complexity: medium (roughly 3-5 focused development days including tests/refinement).
- This can stay a single plan because the work is tightly coupled around one end-to-end feature.

### Codebase and Patterns Inspected

- `tim-gui/TimGUI/ContentView.swift`
  - Currently renders only `SessionsView`.
  - Best insertion point for top-level tab/view switch.
- `tim-gui/TimGUI/SessionsView.swift`
  - Established split-view and empty-state pattern to mirror for Projects view.
- `tim-gui/TimGUI/SessionState.swift`
  - Existing state container pattern with `@Observable` and `@MainActor`.
  - Useful reference for state ownership and UI updates.
- `tim-gui/TimGUI/TimGUIApp.swift`
  - Current app wiring point where shared state objects are created and injected.
  - New project-tracking state/store should be initialized and injected here.
- `tim-gui/TimGUI.xcodeproj/project.pbxproj`
  - No external package dependencies currently configured.
  - New Swift files must be added to target source lists explicitly.
- `src/tim/db/migrations.ts`
  - Authoritative schema and status constraints.
  - Confirms absence of a first-class blocked state for plan tasks.
- `src/tim/db/project.ts`, `src/tim/db/workspace.ts`, `src/tim/db/plan.ts`, `src/tim/db/assignment.ts`
  - Canonical query semantics and joins used by CLI.
  - Useful reference for SQL projections that GUI should mimic.
- `src/common/config_paths.ts`, `src/tim/db/database.ts`
  - Authoritative `tim.db` location logic used by tim CLI.
- `src/tim/commands/workspace.ts`
  - Existing “workspace list with assignment summary” behavior offers a strong template for GUI projections.

### Existing Utilities and APIs to Reuse

- DB path convention:
  - `getTimConfigRoot()` behavior from `src/common/config_paths.ts`
  - `DATABASE_FILENAME` fallback behavior from `src/tim/db/database.ts`
- Status normalization semantics:
  - `src/tim/plans/plan_state_utils.ts`
- Workspace summary logic:
  - assignment recency calculation approach in `handleWorkspaceListCommand` path (`src/tim/commands/workspace.ts`)

These are TypeScript utilities and not directly callable from Swift, but they define canonical behavior the Swift implementation should mirror.

### Architectural Hazards and Constraints

- Data model mismatch hazard:
  - Requested UI states include `blocked`, but schema does not directly store this for task/checklist rows.
- Synchronization hazard:
  - tim CLI writes to SQLite with WAL mode and frequent updates; reader must handle transient busy states cleanly.
- UX hazard:
  - Without clear default filter explanation, users may think tasks are missing.
- Performance hazard:
  - Querying all rows and filtering purely in Swift may become slow on large databases; SQL-side filtering/sorting should be used where possible.
- Testing hazard:
  - If DB path logic is hardcoded, tests become flaky; injectable DB path is required.

### Files Expected to Change/Create

- Modify:
  - `tim-gui/TimGUI/ContentView.swift` (add top-level view switch/tabs)
  - `tim-gui/TimGUI/TimGUIApp.swift` (instantiate and inject project-tracking state/store)
  - `tim-gui/TimGUI.xcodeproj/project.pbxproj` (register new source files and tests)
- Create:
  - `tim-gui/TimGUI/ProjectTrackingModels.swift` (DTOs/enums for project/workspace/task rows and filter states)
  - `tim-gui/TimGUI/ProjectTrackingStore.swift` (SQLite read layer + refresh policy)
  - `tim-gui/TimGUI/ProjectsView.swift` (new project/workspace/task UI)
  - `tim-gui/TimGUITests/ProjectTrackingStoreTests.swift` (SQL projection/filter behavior)
  - `tim-gui/TimGUITests/ProjectTaskFilterTests.swift` (default filter state mapping and recency logic)

No concrete out-of-scope issue requiring a separate discovered-issue plan was found yet; the major gap is requirement clarification, not unrelated engineering debt.

## Implementation Guide

### Expected Behavior/Outcome

- The app has two top-level views:
  - Sessions (existing behavior unchanged)
  - Projects (new)
- In Projects view, users can:
  - Browse projects from `tim.db`
  - See workspaces for the selected project
  - See plan-level task-tracking rows for the selected project (from `plan`)
- Default task filter shows active and near-active work:
  - pending
  - in progress
  - blocked (based on agreed mapping)
  - recently done
- Users can expand filter scope to show all statuses.
- Data refreshes while app is running so recent tim CLI changes appear without restarting.

### Relevant States

- App-level:
  - `sessions_view`
  - `projects_view`
- Projects data states:
  - `idle`
  - `loading`
  - `loaded_empty`
  - `loaded_nonempty`
  - `error`
- Task visibility states:
  - `pending_visible`
  - `in_progress_visible`
  - `blocked_visible`
  - `recently_done_visible`
  - `done_hidden_by_default`
  - `cancelled_hidden_by_default`
  - `deferred_hidden_by_default`
- Workspace display states:
  - `available`
  - `locked`
  - `primary`

### Acceptance Criteria

- [ ] Functional Criterion: User can switch between Sessions and Projects views without losing existing sessions behavior.
- [ ] Functional Criterion: Projects view lists projects and, for selected project, shows associated workspaces and task-tracking rows from `tim.db`.
- [ ] Functional Criterion: Default filter includes only pending, in progress, blocked, or recently done rows.
- [ ] UX Criterion: Projects view has explicit loading, empty, and error states.
- [ ] UX Criterion: Filter state is visible and user-adjustable (including “show all”).
- [ ] Technical Criterion: Data source for projects/workspaces/tasks is SQLite `tim.db` only.
- [ ] Technical Criterion: DB path resolution follows tim config conventions (`XDG_CONFIG_HOME` / `APPDATA` / default home config path).
- [ ] Technical Criterion: Concurrent DB write/read conditions are handled without crashes (busy/retry or graceful error state).
- [ ] All new code paths are covered by tests.

### Dependencies & Constraints

- Dependencies:
  - Plan 184’s SQLite plan/workspace/task sync foundation (already complete).
  - Existing `tim.db` schema and indices.
- Technical Constraints:
  - No current persisted blocked status for `plan_task`.
  - Must preserve existing Sessions UX and websocket behavior.
  - Must support potentially large project/workspace/task datasets without UI lockups.

### Implementation Notes

#### Recommended Approach

1. Define canonical GUI data model and status mapping
- Add a dedicated Swift model file for:
  - `TrackedProject`
  - `TrackedWorkspace`
  - `TrackedTask` (plan-level projection)
  - `TaskVisibilityFilter`
- Encode default-filter semantics in one pure function so tests can validate behavior.
- Implement the agreed blocked/recently-done derivation rules in shared query/filter helpers before wiring UI rendering.
- Keep `plan` as the canonical task source for this feature.

2. Add SQLite-backed store with injectable DB path
- Create `ProjectTrackingStore` as `@Observable` + `@MainActor` state container.
- Implement read-only SQLite queries for:
  - projects list
  - workspaces by project
  - plan/task rows by project with status + updated timestamps
- Add path resolver mirroring `getTimConfigRoot()` + `DATABASE_FILENAME` behavior.
- Keep DB path injectable for tests.

3. Implement refresh lifecycle
- On Projects view appear: load immediately.
- Add periodic refresh (short interval) or lightweight file-change trigger.
- Ensure refresh coalescing/debouncing so rapid DB writes do not flood UI updates.

4. Add new Projects UI
- Add top-level tab switch in `ContentView`.
- Build `ProjectsView` using split-view pattern similar to `SessionsView`.
- Include:
  - project list sidebar
  - workspace list section with lock/primary metadata
  - task list section with status badges and timestamps
  - filter controls and “show all/reset” affordance

5. Preserve Sessions behavior
- Keep `SessionState` and websocket ingestion unchanged.
- Ensure view switching does not tear down active session state.

6. Add automated tests
- Store tests:
  - query mapping from sqlite rows -> Swift model
  - default filter logic
  - recently-done window logic
  - graceful behavior on missing DB/invalid path/busy DB
- UI state tests (where practical):
  - empty/loading/error projections from store state
- Keep tests data-driven and use temporary sqlite fixtures instead of heavy mocks.

7. Document feature behavior
- Update `README.md` and/or `tim-gui` docs with:
  - Projects view purpose
  - default filter semantics
  - DB path source behavior

#### Potential Gotchas

- Treating `plan_task.done` as full task-state can produce misleading UI.
- Naive polling intervals can consume CPU unnecessarily.
- Not handling WAL/busy responses can produce flaky runtime errors.
- If blocked derivation is heuristic, users may misinterpret it as authoritative unless labeled.

#### Manual Testing Steps

1. Launch `tim-gui` with existing session traffic; verify Sessions tab still functions identically.
2. Switch to Projects tab; verify projects populate from local `tim.db`.
3. Select projects with/without workspaces and with/without tasks; validate empty states.
4. Confirm default filter hides older done/cancelled/deferred rows.
5. Toggle filters to show all; validate expected rows appear.
6. Run `tim` CLI operations that update workspace/plan status; verify GUI reflects changes after refresh.
7. Test with missing/renamed DB file to confirm error state behavior.

#### Conflicting, Unclear, or Impossible Requirements

- Requirement resolved for this plan: blocked is dependency-derived for plan-level rows (not checklist-row status).
- Requirement resolved for this plan: “recently done” means `plan.status = 'done'` with `updated_at` in the last 7 days.

## Current Progress
### Current State
- All 14 tasks complete. Feature fully implemented with all review feedback addressed.

### Completed (So Far)
- Tasks 1-8: Core feature implementation (domain models, SQLite store, refresh lifecycle, ProjectsView UI, ContentView integration, tests, documentation)
- Task 9: Fixed refresh coalescing race — replaced `isRefreshing` guard with `needsRefresh` flag + `while` loop so concurrent calls trigger follow-up refresh. Added `selectedProjectId` validation before assigning project-specific data to prevent stale data commits.
- Task 10: Fixed DB path resolution to match tim CLI `getTimConfigRoot()` — trims whitespace from `XDG_CONFIG_HOME` (ignores empty/whitespace-only), added `#if os(Windows)` APPDATA handling with `~/AppData/Roaming` fallback.
- Task 11: Added tests for refresh lifecycle (`startRefreshing`/`stopRefreshing`, restart-after-stop), refresh coalescing (concurrent selection changes, stale data prevention), and DB path resolution (default suffix, custom filename via env var, empty/whitespace XDG fallback, valid XDG usage).
- Task 12: Updated test schema to match production — `INTEGER PRIMARY KEY AUTOINCREMENT` for project.id and workspace.id, `NOT NULL` on plan.plan_id and plan.filename (with defaults), workspace_lock includes all required NOT NULL columns. All test data uses integer IDs.
- Task 13: Fixed Date() consistency in PlansSection.body — single `let now = Date()` passed to both `filteredPlans(now:)` and `displayStatus(for:now:)`.
- Task 14: Added `sqlite3_step` return code validation in all 4 query loops (`doFetchProjects`, `doFetchWorkspaces`, `doFetchPlansAndDeps` plans and deps). Non-`SQLITE_DONE` terminal codes now throw `StoreError.queryFailed(...)` with human-readable `sqlite3_errmsg` instead of silently returning partial data. Added corruption-based tests for projects, workspaces, and plans step-error paths.

### Remaining
- None

### Next Iteration Guidance
- None — all tasks complete

### Decisions / Changes
- Used Apple's built-in `SQLite3` C API rather than adding an external package dependency
- DB connection is opened/closed per query batch (not kept open) — simpler lifecycle, no deinit concerns
- `blocked` status only applies to `pending` plans with unresolved dependencies (not in_progress plans)
- Refresh uses `Task.sleep` with cancellation rather than `Timer.scheduledTimer`
- ContentView uses segmented `Picker` for tab switching (Sessions/Projects) rather than macOS TabView
- ProjectsView follows SessionsView's NavigationSplitView pattern with similar empty state design
- Filter chips use toggle buttons with color-coded backgrounds matching plan status semantics
- Refresh coalescing uses `needsRefresh` flag pattern (not generation token) for simplicity — the while loop re-checks after each full refresh cycle
- Test schema uses `DEFAULT` values for `plan.plan_id` (0) and `plan.filename` ('plan.md') to keep test INSERT statements concise while maintaining NOT NULL constraints

### Lessons Learned
- `return` inside Swift `withCString` closures exits the entire closure, not just the current loop iteration — use `continue` for guard statements inside `while` loops within closures
- When coalescing async operations, a simple boolean guard that drops concurrent calls creates race windows where user-initiated changes are lost. Use a `needsRefresh` flag that the active operation checks after completing, ensuring no request is silently dropped.
- Test schemas that diverge from production (e.g., TEXT vs INTEGER primary keys) can mask real issues. Use production-representative schemas in tests, even if test data needs to be less human-readable (integer IDs instead of string labels).
- SQLite `while sqlite3_step(stmt) == SQLITE_ROW` loops silently swallow errors — always capture the return code, check for `SQLITE_DONE` vs error codes, and include `sqlite3_errmsg(db)` in error messages for diagnostics. In `withCString` closures where you can't throw, capture the error in a local variable and throw after the closure.
- For corruption-based SQLite tests, corrupt data pages beyond page 1 (which holds `sqlite_master`) so `prepare_v2` succeeds but `sqlite3_step` fails. Use `sqlite_master.rootpage` to find specific table root pages for targeted corruption.

### Risks / Blockers
- None
