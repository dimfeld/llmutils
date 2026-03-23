---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: ability to lock and unlock workspaces from web view
goal: ""
id: 259
uuid: 3b4b6840-051e-4e18-b3cd-42d81405cb0a
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-03-23T19:23:06.079Z
promptsGeneratedAt: 2026-03-23T19:23:06.079Z
createdAt: 2026-03-23T19:05:55.654Z
updatedAt: 2026-03-23T19:57:49.913Z
tasks:
  - title: Add getWorkspaceDetail query function to db_queries.ts
    done: true
    description: "Add a `getWorkspaceDetail` function in
      `src/lib/server/db_queries.ts` that loads a single workspace by numeric ID
      with lock info. Create a `WorkspaceDetail` type extending
      `EnrichedWorkspace` with additional detail fields: `description`,
      `createdAt`, and `lockStartedAt`. The function should call
      `cleanStaleLocks(db)` first, run the same LEFT JOIN query on workspace +
      workspace_lock tables filtered by `w.id = ?`, and return the enriched type
      or null."
  - title: Create lock/unlock form remote functions
    done: true
    description: 'Create `src/lib/remote/workspace_actions.remote.ts` with two
      `form` exports from `$app/server`. `lockWorkspace` receives form data with
      `workspaceId`, parses it to a number, verifies the workspace exists via
      `getWorkspaceById` from `src/tim/db/workspace.ts`, then calls
      `acquireWorkspaceLock(db, workspaceId, { lockType: "persistent", hostname:
      os.hostname(), command: "web: manual lock" })`. Catch the already-locked
      error and return `error(409, ...)`. `unlockWorkspace` receives form data
      with `workspaceId`, calls `releaseWorkspaceLock(db, workspaceId, { force:
      true })`. Use Zod schemas for validation.'
  - title: Create workspace detail route and page
    done: true
    description: Create route at
      `src/routes/projects/[projectId]/active/workspace/[workspaceId]/`. The
      `+page.server.ts` loads the workspace using `getWorkspaceDetail` from
      db_queries, validates workspaceId is a valid number, returns 404 if not
      found. The `+page.svelte` displays workspace info (name, path, branch,
      type, assigned plan, description) at the top, then a lock status section
      below (lock type, command, hostname, started time if locked; "Available"
      if unlocked). Shows lock/unlock form buttons. For PID locks, intercept the
      unlock form submit to show a confirmation dialog warning that a process is
      actively using the workspace (display PID, command, hostname). Handle
      submitting states by disabling buttons.
  - title: Make WorkspaceRow clickable with selected state
    done: true
    description: Modify `src/lib/components/WorkspaceRow.svelte` to accept `href`
      and `selected` props. Wrap content in an `<a>` tag when href is provided,
      add `data-sveltekit-preload-data` attribute. Add visual selected state
      styling (similar to ActivePlanRow). Update
      `src/routes/projects/[projectId]/active/+layout.svelte` to pass `href` to
      each WorkspaceRow pointing to
      `/projects/{projectId}/active/workspace/{workspace.id}`, track selected
      workspace from URL params (detect workspace/ prefix in the path), and
      visually deselect plans when a workspace is selected and vice versa.
  - title: Update default page placeholder text
    done: true
    description: Update `src/routes/projects/[projectId]/active/+page.svelte`
      placeholder text from "Select a plan to view details" to "Select a
      workspace or plan to view details".
changedFiles:
  - src/lib/components/WorkspaceRow.svelte
  - src/lib/remote/workspace_actions.remote.ts
  - src/lib/server/db_queries.test.ts
  - src/lib/server/db_queries.ts
  - src/routes/projects/[projectId]/active/+layout.svelte
  - src/routes/projects/[projectId]/active/+page.svelte
  - src/routes/projects/[projectId]/active/workspace/[workspaceId]/+page.server.ts
  - src/routes/projects/[projectId]/active/workspace/[workspaceId]/+page.svelte
tags: []
---

On the active work page, we should be able to click a workspace item to show a route with info about the workspace. From
there we should also be able to set a persistent lock on a workspace, and unlock it as well.

## Expected Behavior/Outcome

When a user clicks a workspace row on the Active Work page, the right pane navigates to a workspace detail view showing:
- Workspace name, path, branch, type, and assigned plan
- Current lock status with details (lock type, command, hostname, started time)
- A button to acquire a persistent lock on an unlocked workspace
- A button to force-release any lock on a locked workspace
- Lock/unlock operations provide immediate visual feedback

### Relevant States
- **Unlocked workspace**: Shows "Lock" button; no lock info displayed
- **Locked (persistent)**: Shows lock details and "Unlock" button
- **Locked (PID)**: Shows lock details and "Unlock" button with confirmation dialog warning that a process is actively using the workspace (force-releases since web user doesn't own the PID)
- **Loading/submitting**: Buttons disabled during lock/unlock operations

## Key Findings

### Product & User Story
As a developer using the tim web interface, I want to click on a workspace in the Active Work sidebar to see its details, and lock/unlock it from there, so I can manage workspace availability without using the CLI.

### Design & UX Approach
- Follow the existing split-pane pattern: workspace rows in the left pane link to a detail view in the right pane, mirroring how plan detail pages work within the active tab.
- The workspace detail route will be a new sub-route under `/projects/[projectId]/active/workspace/[workspaceId]`.
- WorkspaceRow becomes clickable with navigation to the workspace detail page.
- Lock/unlock actions use SvelteKit `form` remote functions (not API endpoints or `command()`), so that `invalidateAll()` is called automatically after mutation, keeping the sidebar workspace list in sync.

### Technical Plan & Risks
- The DB layer already has `acquireWorkspaceLock` and `releaseWorkspaceLock` with full transaction safety.
- For web-initiated locks, we use `force: true` on release since the web server process doesn't own PID-based locks.
- For acquiring, we use `lockType: 'persistent'` since there's no long-running process to track.
- Risk: Concurrent lock/unlock from CLI and web — mitigated by the DB transaction isolation already in place.

### Pragmatic Effort Estimate
Small-to-medium feature. The DB and lock infrastructure is fully built; this is primarily a new route, a detail component, remote functions, and wiring up WorkspaceRow as a link.

## Acceptance Criteria

- [ ] Clicking a workspace row in the Active Work sidebar navigates to workspace detail in the right pane
- [ ] Workspace detail page displays name, path, branch, type, assigned plan, and lock info
- [ ] User can acquire a persistent lock on an unlocked workspace from the detail page
- [ ] User can force-release a lock on a locked workspace from the detail page
- [ ] Unlocking a PID-locked workspace shows a confirmation dialog warning that a process is actively using it
- [ ] Lock/unlock operations show loading state and update the UI upon completion (sidebar updates automatically via `form` invalidation)
- [ ] Navigating between workspaces and plans in the sidebar works correctly
- [ ] All new server-side commands have appropriate error handling

## Dependencies & Constraints

- **Dependencies**: Existing `acquireWorkspaceLock`/`releaseWorkspaceLock` in `src/tim/db/workspace_lock.ts`; existing `getWorkspacesForProject` and `EnrichedWorkspace` type in `src/lib/server/db_queries.ts`; existing active work layout with split-pane pattern.
- **Technical Constraints**: Must use `form` from `$app/server` for mutations (not `+server.ts` API endpoints or `command()`), which provides automatic `invalidateAll()` after successful mutations. Must ensure DB imports stay in `$lib/server/` or `+page.server.ts` files only.

## Implementation Notes

### Recommended Approach
1. Add a `getWorkspaceDetail` query function in `db_queries.ts` that loads a single workspace by ID with lock info
2. Create remote functions for lock/unlock in a new `src/lib/remote/workspace_actions.remote.ts`
3. Add a new route at `src/routes/projects/[projectId]/active/workspace/[workspaceId]/`
4. Make `WorkspaceRow` a clickable link that navigates to the new route
5. Build a `WorkspaceDetail` component for the right pane

### Potential Gotchas
- The `releaseWorkspaceLock` function requires `force: true` to release persistent locks or PID locks not owned by the current process. The web server's lock commands must always use `force: true` for unlock.
- The active work layout currently only has `[planId]` as a sub-route param. Adding a `workspace/[workspaceId]` sub-route needs to coexist without conflicting with the plan UUID route.
- The `hostname` field for web-acquired locks should use `os.hostname()` on the server, and the `command` field should be something descriptive like `"web: manual lock"`.

## Research

### Workspace Database Schema
The `workspace` table stores workspace metadata:
- `id` (INTEGER PK), `project_id` (FK to project), `workspace_path` (TEXT UNIQUE), `name`, `description`, `branch`, `plan_id`, `plan_title`, `workspace_type` (0=standard, 1=primary, 2=auto), `created_at`, `updated_at`

The `workspace_lock` table stores active locks:
- `workspace_id` (FK UNIQUE), `lock_type` ('persistent' | 'pid'), `pid` (nullable), `started_at`, `hostname`, `command`

### DB Lock Functions (`src/tim/db/workspace_lock.ts`)
- `acquireWorkspaceLock(db, workspaceId, { lockType, pid?, hostname, command })` — Runs in an immediate transaction. Checks for existing lock, removes stale ones, throws if already locked.
- `releaseWorkspaceLock(db, workspaceId, { force?, pid? })` — Runs in an immediate transaction. Without `force`, only releases PID locks owned by the matching PID. With `force: true`, releases any lock.
- `getWorkspaceLock(db, workspaceId)` — Returns `WorkspaceLockRow | null`.
- `cleanStaleLocks(db)` — Removes PID locks where the process is dead or >24hrs old.

### Web Query Layer (`src/lib/server/db_queries.ts`)
- `getWorkspacesForProject(db, projectId?)` — Returns `EnrichedWorkspace[]` with lock info joined. Calls `cleanStaleLocks` first.
- `EnrichedWorkspace` includes: `id`, `projectId`, `workspacePath`, `name`, `branch`, `planId`, `planTitle`, `workspaceType`, `isLocked`, `lockInfo: { type, command, hostname } | null`, `updatedAt`, `isRecentlyActive`.
- Currently no function to load a single workspace by ID — needs to be added.

### Active Work Layout (`src/routes/projects/[projectId]/active/`)
- `+layout.server.ts` loads via `getActiveWorkData(db, projectId)` which returns `{ workspaces, activePlans, planNumberToUuid }`.
- `+layout.svelte` renders a split-pane: left sidebar (384px) with workspaces section + active plans section, right pane renders child routes via `{@render children()}`.
- Sub-route `[planId]/+page.svelte` renders `PlanDetail` component. The param is a plan UUID.
- Default `+page.svelte` shows "Select a plan to view details" placeholder.

### WorkspaceRow Component (`src/lib/components/WorkspaceRow.svelte`)
- Currently a non-interactive `<div>` displaying workspace name, badge, branch, plan link, and lock command.
- Accepts `workspace: EnrichedWorkspace`, `projectName?: string`, `planHref?: string | null`.
- Derives display name from `workspace.name` or last path segment.
- Badge status: primary > auto > locked > available.

### SvelteKit Remote Function Pattern
The project uses `command()`, `query()`, and `form()` from `$app/server` for mutations and data fetching. These are placed in `src/lib/remote/*.remote.ts` files. Client components import and call them directly. Validation schemas (Zod or Valibot) validate inputs.

Key differences between `command` and `form`:
- **`command()`**: Called programmatically. Does NOT auto-invalidate load data — must manually call `queryFn(args).refresh()` to update specific queries.
- **`form()`**: Designed for `<form>` elements (spread via `formFn.spread`). Automatically invalidates all load data after success (equivalent to `invalidateAll()`). Input is form data (key-value pairs from hidden inputs / form fields).
- **`query()`**: For data fetching with caching. Call `.refresh()` to update cached data.

Existing examples:
- `src/lib/remote/session_actions.remote.ts` — Multiple `command()` exports for session management
- `src/lib/remote/plan_actions.remote.ts` — `startGenerate` and `startAgent` commands
- `src/lib/remote/pr_status.remote.ts` — Both `query()` and `command()` for PR status

### Route Coexistence
The `[planId]` sub-route under active/ catches any single path segment. A workspace route at `workspace/[workspaceId]` uses two segments (`workspace/123`), so it won't conflict with the single-segment `[planId]` catch.

## Implementation Guide

### Step 1: Add Single-Workspace Query to `db_queries.ts`

Add a `getWorkspaceById` function in `src/lib/server/db_queries.ts` that loads a single `EnrichedWorkspace` by its numeric ID. This mirrors the existing `getWorkspacesForProject` query but for a single row.

The function should:
- Call `cleanStaleLocks(db)` first (consistent with `getWorkspacesForProject`)
- Run the same LEFT JOIN query on `workspace` and `workspace_lock` tables, filtered by `w.id = ?`
- Return the same `EnrichedWorkspace` shape, or `null` if not found
- Include the `lock_started_at` field (map `wl.started_at`) for displaying when the lock was acquired — this is a new field to add to `EnrichedWorkspace` (or to a new `WorkspaceDetail` type that extends it)

Consider whether to create a `WorkspaceDetail` type extending `EnrichedWorkspace` with additional fields like `description`, `createdAt`, and `lock_started_at`, since the list view doesn't need these but the detail view does.

### Step 2: Create Remote Functions for Lock/Unlock

Create `src/lib/remote/workspace_actions.remote.ts` with two `form` exports. Using `form` (not `command`) from `$app/server` ensures all load data is automatically invalidated after mutation, keeping the sidebar workspace list in sync without manual refresh calls.

The `form` function takes form data as input (key-value pairs from the `<form>` element). Use hidden `<input>` fields in the component to pass `workspaceId`.

**`lockWorkspace`**: Receives form data with `workspaceId` (string, parse to number). Server-side:
1. Get `db` from `getServerContext()`
2. Verify workspace exists via `getWorkspaceById` (the DB function from `src/tim/db/workspace.ts`, not the enriched one)
3. Call `acquireWorkspaceLock(db, workspaceId, { lockType: 'persistent', hostname: os.hostname(), command: 'web: manual lock' })`
4. Catch the "already locked" error and return an appropriate error via `error(409, ...)`

**`unlockWorkspace`**: Receives form data with `workspaceId` (string, parse to number). Server-side:
1. Get `db` from `getServerContext()`
2. Call `releaseWorkspaceLock(db, workspaceId, { force: true })` — force is required since the web server doesn't own the lock
3. If returns false (no lock existed), return a no-op success or `error(404, ...)`

In the component, use `<form {...lockWorkspace.spread}>` with a hidden input `<input type="hidden" name="workspaceId" value={workspace.id}>` and a submit button. For the PID lock unlock case, intercept the submit event to show a confirmation dialog before allowing form submission.

### Step 3: Create Workspace Detail Route

Create a new route at `src/routes/projects/[projectId]/active/workspace/[workspaceId]/`:

**`+page.server.ts`**:
- Load the workspace using the new `getWorkspaceById` function from `db_queries.ts`
- Validate `workspaceId` is a valid number
- Return 404 if workspace not found
- Optionally validate the workspace belongs to the current project (redirect if not)

**`+page.svelte`**:
- Display workspace info at the top: name, path, branch, workspace type, assigned plan, description
- Below that, a lock status section: if locked, show lock type, command, hostname, started time; if unlocked, show "Unlocked" status
- Action button: "Lock" when unlocked, "Unlock" when locked
- For PID locks, show a confirmation dialog before unlocking that warns a process is actively using the workspace (include PID, command, and hostname in the warning)
- Handle loading/submitting states (disable button during operation)
- Since we use `form` remote functions, `invalidateAll()` happens automatically — no manual refresh needed

### Step 4: Make WorkspaceRow Clickable

Modify `src/lib/components/WorkspaceRow.svelte`:
- Add an `href` prop (similar to how `ActivePlanRow` works)
- Wrap the content in an `<a>` tag when `href` is provided
- Add `data-sveltekit-preload-data` for fast navigation
- Add a visual selected state (similar to `ActivePlanRow`)

Update `src/routes/projects/[projectId]/active/+layout.svelte`:
- Pass `href` to each `WorkspaceRow` pointing to `/projects/{projectId}/active/workspace/{workspace.id}`
- Track `selectedWorkspaceId` from URL params to highlight the active workspace
- Ensure selecting a workspace deselects any selected plan visually (they're in the same right pane)

### Step 5: Update Default Page Text

Update `src/routes/projects/[projectId]/active/+page.svelte` placeholder text to say "Select a workspace or plan to view details" instead of just "Select a plan to view details".

### Manual Testing Steps
1. Navigate to the Active Work tab
2. Click a workspace row — verify it navigates to workspace detail in the right pane
3. Verify workspace details are displayed correctly (name, path, branch, type, plan, lock status)
4. On an unlocked workspace, click "Lock" — verify the lock is acquired and UI updates
5. On a locked workspace, click "Unlock" — verify the lock is released and UI updates
6. Navigate between workspace detail and plan detail — verify both work correctly
7. Test with workspaces in different states: primary, auto, standard, locked (PID vs persistent)

## Changes Made During Implementation

- **Used `command()` instead of `form()`**: The plan specified `form()` from `$app/server`, but `command()` was used instead because: (1) the entire codebase uses `command()` with zero existing `form()` usage, (2) `command()` with manual `invalidateAll()` achieves the same UI refresh behavior. This keeps the codebase consistent.
- **Nested anchor avoidance**: When WorkspaceRow has an `href` (is clickable), the inner plan link renders as plain text instead of a nested `<a>` tag to avoid invalid HTML.
- **Strict workspace ID validation**: Uses `/^\d+$/` regex instead of `parseInt()` to reject malformed IDs like `123abc`.

## Current Progress
### Current State
- All 5 tasks complete and reviewed
### Completed (So Far)
- Task 1: `getWorkspaceDetail` query in db_queries.ts with `WorkspaceDetail` type
- Task 2: Lock/unlock remote commands in workspace_actions.remote.ts
- Task 3: Workspace detail route at `/projects/[projectId]/active/workspace/[workspaceId]/`
- Task 4: WorkspaceRow clickable with selected state, layout tracks selected workspace
- Task 5: Default page placeholder updated
- Tests for getWorkspaceDetail in db_queries.test.ts
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Used `command()` + `invalidateAll()` instead of `form()` for mutations, matching existing codebase patterns
- Plan link in WorkspaceRow rendered as text (not `<a>`) when row itself is a link, to avoid nested anchors
- Added project ownership validation with redirect in workspace detail route, matching plan detail route pattern
### Lessons Learned
- SvelteKit `command()` does NOT auto-invalidate load data — must call `invalidateAll()` explicitly after mutations
- `parseInt()` silently accepts strings like "123abc" — use regex validation for route params
- When wrapping a component in an `<a>` tag, check for nested `<a>` tags inside — browsers handle nested anchors unpredictably
- Use `afterNavigate` to reset transient UI state (submitting, error messages) when SvelteKit reuses the same component instance across route param changes
### Risks / Blockers
- None
