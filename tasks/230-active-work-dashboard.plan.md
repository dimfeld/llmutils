---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Active work dashboard
goal: ""
id: 230
uuid: 0a5407ee-b3bb-4dff-9790-68f54c8b44a7
generatedBy: agent
status: done
priority: medium
dependencies:
  - 228
parent: 227
references:
  "227": 6787e32d-3918-440e-8b8b-0562ba59e095
  "228": 68fe5243-cd4b-46cf-81e1-6f930d29e40b
planGeneratedAt: 2026-03-17T23:08:47.492Z
promptsGeneratedAt: 2026-03-17T23:08:47.492Z
createdAt: 2026-03-17T09:05:23.149Z
updatedAt: 2026-03-18T00:26:41.021Z
tasks:
  - title: Add workspace query helpers to db_queries.ts
    done: true
    description: "Add EnrichedWorkspace interface, RECENTLY_ACTIVE_WINDOW_MS
      constant (48h), and getWorkspacesForProject(db, projectId?) function to
      src/lib/server/db_queries.ts. The function should: call
      cleanStaleLocks(db) first, use a LEFT JOIN query on workspace +
      workspace_lock to get lock info in one pass, compute isRecentlyActive
      (locked OR primary OR updated within 48h), and sort results by recently
      active first then updated_at DESC. Import cleanStaleLocks from
      $tim/db/workspace_lock.js. Follow the existing query pattern (db: Database
      as first param, return enriched types)."
  - title: Add active work data helper to plans_browser.ts
    done: true
    description: "Add getActiveWorkData(db, projectId) function to
      src/lib/server/plans_browser.ts. It should call getWorkspacesForProject()
      for workspace data, call getPlansForProject() and filter to displayStatus
      === in_progress or blocked, handle all mode by passing undefined for
      projectId, and return { workspaces: EnrichedWorkspace[], activePlans:
      EnrichedPlan[] }. Define ActiveWorkData interface."
  - title: Write tests for workspace query helpers and active work data
    done: true
    description: "Add tests to src/lib/server/db_queries.test.ts (or a new
      active_work.test.ts). Seed workspaces with various states: primary, locked
      (with workspace_lock row via acquireWorkspaceLock), recently updated
      (within 48h), stale (>48h, not locked, not primary). Test
      getWorkspacesForProject() returns correct lock info and isRecentlyActive
      flags. Test stale lock cleanup. Test all-projects mode. Test active plans
      filtering returns only in_progress + blocked. Follow existing test
      patterns: temp DB, beforeEach fresh DB, real fixtures, no mocking."
  - title: Create Active Work route structure with split-pane layout
    done: true
    description: "Convert the placeholder at
      src/routes/projects/[projectId]/active/+page.svelte into a nested route
      structure. Create: +layout.server.ts (loads workspaces + active plans via
      getActiveWorkData), +layout.svelte (split-pane layout with left sidebar
      for workspaces + plans list, right pane for child route), +page.svelte
      (empty state: Select a plan to view details), [planId]/+page.server.ts
      (loads plan detail via getPlanDetailRouteData from plans_browser.ts,
      handles cross-project redirects), [planId]/+page.svelte (renders
      PlanDetail component). Follow the same patterns as the Plans tab route
      structure. The Recently Active toggle state should be stored as $state
      that persists across project switches (do NOT wrap in {#key})."
  - title: Create WorkspaceBadge component
    done: true
    description: "Create src/lib/components/WorkspaceBadge.svelte. Props: status:
      primary | locked | available. Color mapping: primary -> blue (bg-blue-100
      text-blue-800), locked -> amber (bg-amber-100 text-amber-800), available
      -> gray (bg-gray-100 text-gray-700). Use the same pill badge pattern as
      StatusBadge.svelte."
  - title: Create WorkspaceRow component
    done: true
    description: "Create src/lib/components/WorkspaceRow.svelte. Props: workspace:
      EnrichedWorkspace, optional projectName: string, planHref: string | null.
      Display: workspace name (name field if set, else last path segment of
      workspacePath), branch chip (small rounded badge), assigned plan info as a
      link using planHref (Plan #planId - planTitle), WorkspaceBadge
      (Primary/Locked/Available), lock command info (small text if locked),
      project name (if provided for all-projects mode). Card-style row matching
      PlanRow visual weight."
  - title: Create ActivePlanRow component with relative timestamps
    done: true
    description: "Create src/lib/components/ActivePlanRow.svelte. Props: plan:
      EnrichedPlan, selected: boolean, href: string, optional projectName:
      string. Display: plan # badge, title, goal (truncated), status badge,
      priority badge, relative timestamp (e.g. 2 hours ago). Add a
      formatRelativeTime(isoString) helper function in a shared utils file
      (src/lib/utils/time.ts). Use simple thresholds: minutes, hours, days,
      weeks. Highlight selected plan same as PlanRow does."
  - title: Build the Active Work left pane content in layout.svelte
    done: true
    description: "In the +layout.svelte created in step 4, build the left pane
      content: Workspaces section with header and Recently Active/All toggle
      button, list of WorkspaceRow components with client-side filtering via
      $derived based on toggle and isRecentlyActive flag, empty states for no
      workspaces. Active Plans section with header, list of ActivePlanRow
      components linking to /projects/[projectId]/active/[planUuid], selected
      plan highlighting from $page.params.planId, empty state. Show project
      names when projectId === all (build projectNamesByProjectId map from
      projects data). Build planId-to-UUID mapping for workspace plan links."
changedFiles:
  - README.md
  - src/lib/components/ActivePlanRow.svelte
  - src/lib/components/PlanDetail.svelte
  - src/lib/components/WorkspaceBadge.svelte
  - src/lib/components/WorkspaceRow.svelte
  - src/lib/server/db_queries.test.ts
  - src/lib/server/db_queries.ts
  - src/lib/server/plans_browser.test.ts
  - src/lib/server/plans_browser.ts
  - src/lib/utils/time.test.ts
  - src/lib/utils/time.ts
  - src/routes/projects/[projectId]/active/+layout.server.ts
  - src/routes/projects/[projectId]/active/+layout.svelte
  - src/routes/projects/[projectId]/active/+page.svelte
  - src/routes/projects/[projectId]/active/[planId]/+page.server.ts
  - src/routes/projects/[projectId]/active/[planId]/+page.svelte
tags: []
---

Implement the Active Work tab showing per-project workspaces and active plans. Workspaces section shows recently active workspaces by default (locked, primary, or updated within 48 hours) with toggle to show all. Plans section shows in_progress and blocked plans only. Reuses project sidebar and plan display components from plan 228.

## Expected Behavior/Outcome

The Active Work tab provides a dashboard view of current work per project:
- **Workspaces section**: Shows workspaces for the selected project, filtered to "recently active" by default (locked, primary, or updated within 48 hours). A toggle allows viewing all workspaces. Each workspace row displays name/path, branch, assigned plan, and status badge.
- **Active plans section**: Shows only in_progress and blocked plans for the selected project. Each plan row shows plan #, title, goal, status badge, priority badge, and relative timestamp. Clicking a plan shows its full detail in the right pane.
- **Plan detail pane**: Right side of split-pane layout. Reuses the existing `PlanDetail` component with full data (dependencies, assignment, parent, tasks, tags, timestamps). Shows "Select a plan" empty state when no plan is selected.
- **Project sidebar**: Reuses the existing `ProjectSidebar` component. Selecting a project filters both sections. "All Projects" shows workspaces and active plans across all projects.

### Relevant States
- **Workspace statuses**: Primary (blue badge), Locked (yellow badge), Available (gray badge)
- **Plan display statuses shown**: in_progress, blocked only
- **Recently active criteria**: workspace is locked, is primary, or has `updated_at` within 48 hours

## Key Findings

### Product & User Story
Developers running tim agents need a quick overview of what's currently being worked on. The Active Work tab answers "what workspaces are in use and what plans are active?" at a glance, without needing to browse the full plan list or check workspace status via CLI.

### Design & UX Approach
- Split-pane layout matching the Plans tab: left pane has workspaces + active plans list (scrolling together), right pane shows plan detail when selected
- Nested route `/projects/[projectId]/active/[planId]` for plan detail view, reusing existing `PlanDetail` component
- "Recently active" toggle for workspaces (defaults to filtered, persists across project switches)
- Workspace rows with assigned plan links navigate to the plan detail in the right pane
- Reuses StatusBadge, PriorityBadge, PlanDetail, and display patterns from plan 228
- New WorkspaceBadge for Primary/Locked/Available status display

### Technical Plan & Risks
- Server-side data loading via `+page.server.ts` following established patterns
- New `getWorkspacesForProject()` and `getActiveWorkData()` query helpers in `db_queries.ts`
- Workspace lock status requires LEFT JOIN to `workspace_lock` table
- Recently-active filtering done server-side (48-hour window computed from `updated_at`)
- **Risk**: Lock staleness detection (pid-based locks where process died) — should use same `isLockStale()` logic from `workspace_lock.ts`
- **Risk**: "All projects" mode requires querying workspaces across all projects efficiently

### Pragmatic Effort Estimate
Small-to-medium scope. Mostly straightforward DB queries + UI components, building on established patterns from plan 228. The workspace section is new but the active plans section is essentially a filtered subset of the plans browser.

## Acceptance Criteria
- [ ] Active Work tab loads workspace data for the selected project
- [ ] Workspaces show name/path, branch chip, assigned plan info, and status badge (Primary/Locked/Available)
- [ ] "Recently active" filter is on by default, showing only locked, primary, or recently-updated workspaces
- [ ] Toggle switches between recently-active and all workspaces; toggle state persists across project switches
- [ ] Active plans section shows only in_progress and blocked plans
- [ ] Clicking a plan (in the active plans list or from a workspace's assigned plan link) shows full plan detail in the right pane
- [ ] Plan detail view reuses the existing `PlanDetail` component with full data (dependencies, assignment, parent, etc.)
- [ ] "All Projects" mode works correctly for both workspaces and plans
- [ ] Empty states are shown when no workspaces or active plans exist
- [ ] All new server-side query helpers are covered by tests
- [ ] All new code paths are covered by tests

## Dependencies & Constraints
- **Dependencies**: Plan 228 (done) — provides shared layout, ProjectSidebar, StatusBadge, PriorityBadge, PlanRow, db_queries infrastructure, server initialization
- **Technical Constraints**: All DB operations must be synchronous (bun:sqlite). Server-only modules must stay in `$lib/server/`. Lock staleness detection involves checking if a PID is alive, which must happen server-side.

## Research

### 1. Existing Infrastructure from Plan 228

The core infrastructure is fully in place:

**Server initialization** (`src/lib/server/init.ts`): Lazy singleton pattern returning `{ config, db }` via `getServerContext()`. All server routes access the DB through this.

**DB query helpers** (`src/lib/server/db_queries.ts`): Provides `getProjectsWithMetadata()`, `getPlansForProject()`, `getPlanDetail()`, and the enrichment pipeline that computes display statuses (blocked, recently_done) from dependency resolution.

**Plans browser abstraction** (`src/lib/server/plans_browser.ts`): Thin wrapper with `getPlansPageData()` that converts route params to DB query args. The Active Work page will follow this same pattern.

**Route structure**: `/projects/[projectId]/active/+page.svelte` already exists as a placeholder ("Active Work — coming soon"). The project layout at `/projects/[projectId]/+layout.svelte` renders `ProjectSidebar` and a content area. The project layout server load validates `projectId`, handles "all" mode, and persists to cookie.

**Shared components**: `StatusBadge`, `PriorityBadge`, `PlanRow`, `ProjectSidebar`, `TabNav`, `FilterChips` are all available.

### 2. Workspace Database Layer

**`src/tim/db/workspace.ts`** — Core CRUD:
- `WorkspaceRow` interface: `id`, `project_id`, `task_id`, `workspace_path`, `branch`, `name`, `description`, `plan_id`, `plan_title`, `is_primary` (0/1 int), `created_at`, `updated_at` (ISO-8601)
- `findWorkspacesByProjectId(db, projectId)` → `WorkspaceRow[]` ordered by `created_at DESC`
- `listAllWorkspaces(db)` → `WorkspaceRow[]` ordered by `created_at DESC`
- `recordWorkspace()` — upsert on `workspace_path`

**`src/tim/db/workspace_lock.ts`** — Lock management:
- `WorkspaceLockRow` interface: `workspace_id`, `lock_type` ('persistent'|'pid'), `pid`, `started_at`, `hostname`, `command`
- `getWorkspaceLock(db, workspaceId)` → `WorkspaceLockRow | null`
- `isProcessAlive(pid)` — uses `process.kill(pid, 0)`
- `isLockStale()` — private function: pid locks are stale if process is dead OR older than 24 hours
- `cleanStaleLocks(db)` — removes all stale locks, returns count removed

**`src/tim/db/assignment.ts`** — Assignment tracking:
- `getAssignmentEntriesByProject(db, projectId)` → `Record<string, AssignmentEntry>` keyed by plan UUID
- `AssignmentEntry`: `planId`, `workspacePaths[]`, `users[]`, `status`, `assignedAt`, `updatedAt`

**`src/tim/workspace/workspace_info.ts`** — Enrichment layer:
- `WorkspaceInfo` interface: enriched workspace with `lockedBy` object (type, pid, startedAt, hostname, command), `isPrimary`, etc.
- `workspaceRowToInfo()` — converts DB row to enriched info, looks up lock and issues
- Note: These functions use `getDatabase()` singleton — for the web layer, we should write our own query that takes `db` as a parameter (matching the pattern in `db_queries.ts`).

### 3. Workspace Display Requirements

From the parent plan (227), the macOS app shows:
- **Workspace rows**: name, branch chip, assigned plan, status badge (Primary/Locked/Available)
- **Recently active**: locked, primary, or updated within 48 hours
- **Active plans**: in_progress + blocked only
- **Plan rows**: plan #, title, goal, status badge, relative timestamp

### 4. Data Shape for Active Work

The page needs two data sets:

**Workspaces** — Need to join `workspace` with `workspace_lock` (LEFT JOIN) to get lock info. For display:
```typescript
interface EnrichedWorkspace {
  id: number;
  projectId: number;
  workspacePath: string;
  name: string | null;
  branch: string | null;
  planId: string | null;       // assigned plan ID (text, not numeric)
  planTitle: string | null;     // assigned plan title
  isPrimary: boolean;
  isLocked: boolean;
  lockInfo: { type: string; command: string; hostname: string } | null;
  updatedAt: string;
  isRecentlyActive: boolean;    // computed: locked OR primary OR updated within 48h
}
```

**Active Plans** — Can reuse the existing `getPlansForProject()` enrichment pipeline, filtering to `displayStatus === 'in_progress' || displayStatus === 'blocked'` after enrichment.

### 5. Testing Patterns

From `src/lib/server/db_queries.test.ts`:
- Uses `beforeAll` to create temp dir, `beforeEach` to create fresh DB with `openDatabase()`
- Seeds data with `getOrCreateProject()`, `upsertPlan()`, `recordWorkspace()`, `claimAssignment()`
- Tests verify computed properties (display statuses, counts, enrichment)
- No mocking — real DB fixtures throughout

For workspace tests, we'll need to seed workspaces with various states:
- Primary workspace
- Locked workspace (with workspace_lock row)
- Recently updated workspace (updated_at within 48h)
- Stale workspace (updated_at > 48h ago, not locked, not primary)

### 6. Lock Staleness in Web Context

The `isLockStale()` function in `workspace_lock.ts` is private. It checks:
1. If `lock_type !== 'pid'`, never stale (persistent locks)
2. If pid is null or process is dead → stale
3. If started_at > 24 hours ago → stale

For the web UI, we should call `cleanStaleLocks(db)` before querying workspaces to ensure we don't show stale locks. This is a quick scan that runs a DELETE for any stale pid-based locks. The web query helper can call this at the start.

### 7. "All Projects" Mode

When `projectId === 'all'`:
- Workspaces: use `listAllWorkspaces(db)` instead of `findWorkspacesByProjectId()`
- Plans: use `getPlansForProject(db)` without projectId (already supported)
- Need to show project name alongside workspace rows (similar to how Plans browser shows project names in "all" mode)

## Implementation Guide

### Step 1: Add Workspace Query Helpers to `db_queries.ts`

Add new functions to `src/lib/server/db_queries.ts`:

1. **`getWorkspacesForProject(db, projectId?): EnrichedWorkspace[]`**
   - Call `cleanStaleLocks(db)` first to prune dead locks
   - If `projectId` is undefined, query all workspaces; otherwise filter by project_id
   - LEFT JOIN `workspace_lock` on `workspace_id` to get lock info
   - Compute `isRecentlyActive`: workspace is locked (has non-null lock row), is primary (`is_primary = 1`), or `updated_at` is within 48 hours
   - Return enriched workspace objects sorted by: recently active first, then by `updated_at` DESC

2. **Define `EnrichedWorkspace` interface** in `db_queries.ts`:
   ```typescript
   export interface EnrichedWorkspace {
     id: number;
     projectId: number;
     workspacePath: string;
     name: string | null;
     branch: string | null;
     planId: string | null;
     planTitle: string | null;
     isPrimary: boolean;
     isLocked: boolean;
     lockInfo: { type: string; command: string; hostname: string } | null;
     updatedAt: string;
     isRecentlyActive: boolean;
   }
   ```

3. **Define `RECENTLY_ACTIVE_WINDOW_MS = 48 * 60 * 60 * 1000`** constant (48 hours)

The query pattern should match what's already in `db_queries.ts` — take `db: Database` as first param, return enriched types.

Import `cleanStaleLocks` from `$tim/db/workspace_lock.js` and `findWorkspacesByProjectId`, `listAllWorkspaces` from `$tim/db/workspace.js`. For the lock join, write a direct SQL query that does the LEFT JOIN in one pass rather than N+1 queries.

### Step 2: Add Active Work Data Helper to `plans_browser.ts`

Add a function to `src/lib/server/plans_browser.ts`:

**`getActiveWorkData(db, projectId): ActiveWorkData`**
- Calls `getWorkspacesForProject(db, numericProjectId)` for workspace data
- Calls `getPlansForProject(db, numericProjectId)` and filters to `displayStatus === 'in_progress' || displayStatus === 'blocked'`
- Returns `{ workspaces: EnrichedWorkspace[], activePlans: EnrichedPlan[] }`
- Handles "all" mode by passing `undefined` for projectId

### Step 3: Write Tests for Workspace Query Helpers

Add tests to `src/lib/server/db_queries.test.ts` (or a new `active_work.test.ts` file):

- Seed workspaces with various states: primary, locked (with lock row), recently updated, stale
- Test `getWorkspacesForProject()` returns correct lock info and `isRecentlyActive` flags
- Test that stale locks are cleaned before returning
- Test "all projects" mode returns workspaces across projects
- Test the active plans filtering (only in_progress + blocked)

Use the same pattern as existing tests: temp DB, `beforeEach` fresh DB, seed with `recordWorkspace()`, `acquireWorkspaceLock()`, `upsertPlan()`.

### Step 4: Create the Active Work Route Structure with Split-Pane Layout

The Active Work tab uses a split-pane layout matching the Plans tab. This requires converting the existing placeholder into a nested route structure:

**Route structure:**
```
src/routes/projects/[projectId]/active/
├── +layout.svelte          (Split-pane: left sidebar with workspaces + plans list, right detail area)
├── +layout.server.ts       (Load workspaces + active plans data)
├── +page.svelte            (Empty state / "Select a plan" message for right pane)
└── [planId]/
    ├── +page.svelte         (Plan detail display in right pane)
    └── +page.server.ts      (Load single plan detail)
```

**Create `src/routes/projects/[projectId]/active/+layout.server.ts`**:
- Load function calls `getServerContext()` to get DB
- Gets `projectId` from parent data
- Calls `getActiveWorkData(db, projectId)`
- Returns `{ workspaces, activePlans, projectId }`
- Follow the same pattern as `src/routes/projects/[projectId]/plans/+layout.server.ts`

**Create `src/routes/projects/[projectId]/active/+layout.svelte`**:
- Split-pane layout: left pane with workspaces + active plans list (scrolling together), right pane renders child route (plan detail or empty state)
- Left pane contains: workspaces section with toggle, then active plans section
- "Recently active" toggle state stored as `$state` that persists across project switches (not wrapped in `{#key}`)
- Uses `$page.params.planId` to determine which plan is selected (for highlighting in the list)
- Show project names on rows when `projectId === 'all'`

**Create `src/routes/projects/[projectId]/active/+page.svelte`**:
- Empty/default state for right pane: "Select a plan to view details"

**Create `src/routes/projects/[projectId]/active/[planId]/+page.server.ts`**:
- Load plan detail using `getPlanDetailRouteData()` from `plans_browser.ts` (same as Plans tab)
- Handle cross-project redirects the same way

**Create `src/routes/projects/[projectId]/active/[planId]/+page.svelte`**:
- Render `PlanDetail` component with full plan data
- Reuse same pattern as `src/routes/projects/[projectId]/plans/[planId]/+page.svelte`

### Step 5: Create WorkspaceBadge Component

**Create `src/lib/components/WorkspaceBadge.svelte`**:
- Props: `status: 'primary' | 'locked' | 'available'`
- Color mapping:
  - `primary` → blue (bg-blue-100 text-blue-800)
  - `locked` → yellow/amber (bg-amber-100 text-amber-800)
  - `available` → gray (bg-gray-100 text-gray-700)
- Same pill badge pattern as `StatusBadge.svelte`

### Step 6: Create WorkspaceRow Component

**Create `src/lib/components/WorkspaceRow.svelte`**:
- Props: `workspace: EnrichedWorkspace`, optional `projectName: string`, `planHref: string | null` (link for assigned plan)
- Display:
  - Workspace name (use `name` field if set, else last path segment of `workspacePath`)
  - Branch chip (if branch is set) — small rounded badge with branch name
  - Assigned plan info: "Plan #planId — planTitle" (if planId is set) — rendered as a link using `planHref` prop, navigating to plan detail in the right pane
  - WorkspaceBadge showing Primary/Locked/Available
  - Lock command info (small text showing what's running, if locked)
  - Project name (if provided, for "all projects" mode)
- Styling: Card-style row with padding, border, hover effect. Match the existing PlanRow visual weight.

### Step 7: Create ActivePlanRow Component (or Reuse PlanRow)

Evaluate whether the existing `PlanRow` component can be reused directly. It displays: plan #, title, status badge, priority badge, task counts, epic indicator, and supports `projectName` prop.

The parent plan says active plan rows should show: "plan #, title, goal, status badge, relative timestamp". This is close to `PlanRow` but adds goal text and relative timestamp.

Option A: Extend `PlanRow` with optional goal display and relative timestamp.
Option B: Create a separate `ActivePlanRow` component with a slightly different layout that includes goal text.

Recommend Option B — create `ActivePlanRow.svelte` since the layout is different enough (shows goal text inline, relative timestamp instead of task counts).

**Create `src/lib/components/ActivePlanRow.svelte`**:
- Props: `plan: EnrichedPlan`, optional `projectName: string`
- Display: plan # badge, title, goal (truncated), status badge, priority badge, relative timestamp (e.g., "2 hours ago")
- Add a `formatRelativeTime(isoString)` helper (either inline or in a shared utils file)

### Step 8: Build the Active Work Layout and List UI

The layout is built in `+layout.svelte` (created in Step 4). The left pane content:

Layout:
```
┌──────────────────────┬──────────────────────┐
│ Workspaces   [toggle]│                      │
│ ┌──────────────────┐ │                      │
│ │ WorkspaceRow     │ │   Plan Detail        │
│ │ WorkspaceRow     │ │   (child route)      │
│ └──────────────────┘ │                      │
│                      │                      │
│ Active Plans         │                      │
│ ┌──────────────────┐ │                      │
│ │ ActivePlanRow    │ │                      │
│ │ ActivePlanRow    │ │                      │
│ └──────────────────┘ │                      │
└──────────────────────┴──────────────────────┘
```

Left pane (inside `+layout.svelte`):
- Section headers with clear labels
- Workspaces section:
  - Header with "Workspaces" label and toggle button ("Recently Active" / "All")
  - List of `WorkspaceRow` components
  - Empty state: "No workspaces found" / "No recently active workspaces"
  - Client-side filtering based on toggle (all data loaded, filtered via `$derived`)
- Active Plans section:
  - Header with "Active Plans" label
  - List of `ActivePlanRow` components, each linking to `/projects/[projectId]/active/[planUuid]`
  - Selected plan highlighted (matched from `$page.params.planId`)
  - Empty state: "No active plans"
- Show project names on rows when in "All Projects" mode (same pattern as Plans browser)
- Do NOT use `{#key data.projectId}` so that the "Recently Active" toggle persists across project switches

### Manual Testing Steps
1. Start dev server with `bun run dev`
2. Navigate to Active Work tab
3. Verify workspaces load for selected project with correct status badges
4. Toggle "Recently Active" / "All" and verify filtering works
5. Verify active plans show only in_progress and blocked plans
6. Click an active plan — verify plan detail appears in right pane
7. Click a workspace's assigned plan link — verify it navigates to plan detail in right pane
8. Switch projects — verify toggle state persists but data updates
9. Switch to "All Projects" and verify cross-project data with project names
10. Test with a project that has no workspaces — verify empty state
11. Test with a project that has no active plans — verify empty state
12. Verify the right pane shows "Select a plan" when no plan is selected

## Implementation Notes

### Recommended Approach
- Start with the server-side query helpers and tests (Steps 1-3) since they're the foundation
- Then build the page server load (Step 4) and UI components (Steps 5-8)
- Keep the active plans simple by reusing `getPlansForProject()` and filtering client-side or server-side

### Potential Gotchas
- **Lock staleness**: Must call `cleanStaleLocks()` before querying to avoid showing stale locks. This mutates the DB (deletes stale rows) but is idempotent and fast.
- **WorkspaceRow `plan_id`**: This is a TEXT field containing the plan number as a string (e.g., "103"), not a foreign key to the plan table. It's set by the CLI when a workspace is assigned to a plan. It may be null.
- **"All Projects" workspace display**: Need project names for each workspace. Can look up from project table by `project_id`. Follow the same pattern as Plans browser — build a `projectNamesByProjectId` map.
- **Relative timestamps**: Need a utility to format ISO-8601 timestamps as relative times ("2 hours ago", "3 days ago"). Keep it simple — no need for a library. A small helper function with thresholds (minutes, hours, days, weeks) is sufficient.
- **`is_primary` is an integer**: 0 or 1 in the DB. Convert to boolean when creating `EnrichedWorkspace`.
- **Workspace plan_id to plan UUID mapping**: The workspace `plan_id` field is a text plan number (e.g., "103"), not a UUID. To link from a workspace row to the plan detail route (which uses plan UUID), the layout needs to build a mapping from plan number to plan UUID using the loaded active plans data. If a workspace's assigned plan isn't in the active plans list (e.g., it's done/pending), the link can be omitted or fall back.
- **Split-pane detail route**: The plan detail sub-route (`/active/[planId]`) should use the plan UUID as the `planId` param (matching the Plans tab convention). Reuse `getPlanDetailRouteData()` from `plans_browser.ts`.

## Current Progress
### Current State
- All 8 tasks complete. Plan is done.
### Completed (So Far)
- Tasks 1-3: Server data layer (EnrichedWorkspace, getWorkspacesForProject, getActiveWorkData, tests)
- Tasks 4-8: UI (route structure, WorkspaceBadge, WorkspaceRow, ActivePlanRow, layout with toggle/filtering)
- Review follow-ups: PlanDetail tab prop, workspace plan link collision fix, formatRelativeTime NaN guard, README update
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- lockInfo condition uses `isLocked` (lock_type !== null) for consistency, with empty string fallbacks for command/hostname
- `getPlanDetailRouteData` now accepts a `tab` parameter (default 'plans') for cross-project redirect URLs
- `PlanDetail` accepts a `tab` prop for context-aware dependency/parent links. Active Work tab leaves it as default 'plans' since dependencies can be any status.
- Workspace plan links always stay in the Active Work tab via `planNumberToUuid` map (includes all plans, not just active)
- All-project workspace link keyed by `${projectId}:${planId}` to avoid cross-project plan number collisions
### Lessons Learned
- When removing SQL ORDER BY in favor of JS sorting, ensure the JS sort has a stable tiebreaker (e.g. by ID) for rows with identical sort keys
- Workspace `plan_id` is project-scoped (not globally unique), so any plan-number lookup must include the project ID
- PlanDetail dependency links should generally point to the Plans tab since dependencies can be any status; using the current tab creates confusing UX when dependencies aren't visible in the current view's sidebar
### Risks / Blockers
- None
