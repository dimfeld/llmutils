# Web Interface (Plans Browser)

## SvelteKit Conventions

### Data Loading

- Child layouts should use `await parent()` to access data already loaded by parent layouts instead of re-querying the database. This avoids duplicate work and keeps data consistent.
- All DB imports must be in `$lib/server/` or `+page.server.ts` files — `bun:sqlite` cannot be imported client-side.
- The server context (`src/lib/server/init.ts`) is lazily initialized because SvelteKit may import server modules during `svelte-kit sync` or type checking without a running server.

### Reactivity Gotchas (Svelte 5)

- `$derived(() => { ... })` wraps the **function object itself**, not the return value. For multi-statement derivations, use `$derived.by(() => { ... })`.
- SvelteKit **reuses page components** across param-only navigations — local `$state` persists across route changes. Use `afterNavigate` to reset `$state` when needed, though best is to use a "writable derived" when possible.

## Architecture

- Route structure: `/projects/[projectId]/{tab}` where `projectId` is a numeric ID or `all`
- Tabs: `sessions`, `active`, `plans`
- `src/lib/server/plans_browser.ts` is the abstraction layer between route handlers and `db_queries.ts`
- Display statuses (`blocked`, `recently_done`) are computed server-side in `db_queries.ts`, not stored in DB
- Cookie-based project persistence: `src/lib/stores/project.svelte.ts` manages the last-selected project ID (httpOnly cookie, server-read only)

## Active Work Tab

The Active Work tab (`/projects/[projectId]/active`) provides a dashboard of current work per project with a split-pane layout.

### Route Structure

```
src/routes/projects/[projectId]/active/
├── +layout.server.ts       # Loads workspaces + active plans via getActiveWorkData()
├── +layout.svelte          # Split-pane: left sidebar (workspaces + plans list), right detail area
├── +page.svelte            # Empty state: "Select a plan to view details"
└── [planId]/
    ├── +page.server.ts     # Loads plan detail via getPlanDetailRouteData(tab: 'plans')
    └── +page.svelte        # Renders PlanDetail component
```

### Data Flow

- `getWorkspacesForProject(db, projectId?)` in `db_queries.ts` — LEFT JOINs `workspace` with `workspace_lock`, calls `cleanStaleLocks(db)` first, returns `EnrichedWorkspace[]` with `isRecentlyActive` computed flag
- `getActiveWorkData(db, projectId)` in `plans_browser.ts` — combines workspace data with plans filtered to `displayStatus === 'in_progress' || 'blocked'`
- "Recently active" criteria: workspace is locked, is primary, or has `updated_at` within 48 hours (`RECENTLY_ACTIVE_WINDOW_MS`)

### Components

- `WorkspaceBadge.svelte` — pill badge for workspace status: Primary (blue), Locked (amber), Available (gray)
- `WorkspaceRow.svelte` — card-style row showing workspace name/path, branch chip, assigned plan link, status badge, lock command info, optional project name
- `ActivePlanRow.svelte` — plan row with plan #, title, goal (truncated), status/priority badges, and relative timestamp
- `src/lib/utils/time.ts` — `formatRelativeTime()` helper for human-readable relative timestamps

### Key Behaviors

- **Workspace `plan_id` is project-scoped, not globally unique.** Any lookup from a workspace's `plan_id` (text plan number) to a plan UUID must include the project ID to avoid collisions across projects. The "All Projects" mode is the most visible case — workspace plan links use a `planNumberToUuid` map keyed by `${projectId}:${planId}`.
- "Recently Active" toggle defaults to filtered; toggle state is `$state` that persists across project switches (not wrapped in `{#key}`)
- Plan detail sub-route reuses `PlanDetail` component; `getPlanDetailRouteData()` accepts a `tab` parameter for cross-project redirect URLs
- Dependency/parent links in PlanDetail point to the Plans tab (not Active Work) since dependencies can be any status
