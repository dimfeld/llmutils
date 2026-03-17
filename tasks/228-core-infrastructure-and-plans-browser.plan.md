---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Core infrastructure and plans browser
goal: ""
id: 228
uuid: 68fe5243-cd4b-46cf-81e1-6f930d29e40b
generatedBy: agent
status: done
priority: medium
parent: 227
references:
  "227": 6787e32d-3918-440e-8b8b-0562ba59e095
planGeneratedAt: 2026-03-17T09:28:56.444Z
promptsGeneratedAt: 2026-03-17T09:28:56.444Z
createdAt: 2026-03-17T09:05:10.929Z
updatedAt: 2026-03-17T20:06:03.374Z
tasks:
  - title: Server initialization and shared context
    done: true
    description: "Create src/lib/server/init.ts with lazy-init singleton: load tim
      global config, get DB via getDatabase(). Export getServerContext()
      returning { config, db }. Use $tim and $common aliases for imports."
  - title: Server-side DB query helpers
    done: true
    description: "Create src/lib/server/db_queries.ts with: (1)
      getProjectsWithMetadata(db) - list projects with plan counts by status;
      (2) getPlansForProject(db, projectId?) - combine plans, tasks, deps, tags
      into enriched objects with computed display status (blocked =
      pending/in_progress with unresolved deps, recently_done = done within 7
      days), task completion counts; when projectId omitted, query all projects
      with single unfiltered query; (3) getPlanDetail(db, planUuid) - single
      plan with tasks, deps (with titles/statuses), tags, assignment info."
  - title: DB query helper tests
    done: true
    description: "Create src/lib/server/db_queries.test.ts. Set up real test DB with
      fixture data (projects, plans with various statuses, dependencies, tasks,
      tags). Test: getProjectsWithMetadata returns correct plan counts;
      getPlansForProject correctly computes blocked display status,
      recently_done display status, and raw status for plans without deps;
      getPlanDetail returns full data with dependency titles/statuses;
      all-projects mode returns plans from multiple projects."
  - title: Root layout with tab navigation
    done: true
    description: Modify src/routes/+layout.svelte to render app shell with fixed
      header bar containing app title and TabNav component. Create
      src/routes/+layout.server.ts to load project list via
      getProjectsWithMetadata(). Create src/lib/components/TabNav.svelte with
      three tabs (Sessions, Active Work, Plans) linking to
      /projects/{projectId}/{tab}, highlighting active tab based on current
      route path.
  - title: Route-based project selection with cookie persistence
    done: true
    description: "Create src/lib/stores/project.svelte.ts with helpers:
      setLastProjectId(id) saves to cookie, getLastProjectId(cookies) reads from
      cookie, projectUrl(projectId, tab) builds /projects/{id}/{tab} URLs.
      Create route group src/routes/projects/[projectId]/ with +layout.server.ts
      (reads projectId param, validates, sets cookie, returns project data) and
      +layout.svelte (renders ProjectSidebar + content area). Create
      src/lib/components/ProjectSidebar.svelte showing project list with last 2
      path components as display name, click navigates to
      /projects/{id}/{currentTab}."
  - title: Plans browser server load and page
    done: true
    description: "Create src/routes/projects/[projectId]/plans/+page.server.ts to
      load plans via getPlansForProject(). Create
      src/routes/projects/[projectId]/plans/+page.svelte with two-column layout:
      plan list (left) and plan detail (right). Use $state() for local UI state
      (search query, status filters, sort option, selected plan ID)."
  - title: Plan list with filtering and sorting components
    done: true
    description: "Create src/lib/components/PlansList.svelte with: search field
      (case-insensitive title+goal match), sort picker (Recently Updated, Plan
      #, Priority), status filter chips via FilterChips component, grouped plan
      list by display status ordered by actionability (In Progress > Blocked >
      Pending > Needs Review > Recently Done > Done > Cancelled > Deferred).
      Groups are collapsible; Done/Cancelled/Deferred start collapsed. Create
      src/lib/components/FilterChips.svelte for multi-select status filter chips
      with Reset button. Create src/lib/components/PlanRow.svelte showing plan
      #, title, priority badge, status badge, task completion count."
  - title: Plan detail display component
    done: true
    description: "Create src/lib/components/PlanDetail.svelte showing: header (# +
      title), status/priority badges, goal, tasks (expanded by default with
      title + description + checkmark), dependencies (clickable, with visual
      resolved/unresolved indication - muted for done deps, amber for blocking),
      assigned workspace, parent plan link, tags, timestamps, epic indicator.
      Clicking a dependency navigates to that plan in the detail pane."
  - title: Reusable badge components
    done: true
    description: "Create src/lib/components/StatusBadge.svelte with color mapping:
      in_progress=blue, blocked=yellow/amber, pending=gray,
      done/recently_done=green, cancelled=red, deferred=purple,
      needs_review=orange. Create src/lib/components/PriorityBadge.svelte with
      color mapping: urgent=red, high=orange, medium=yellow, low=blue,
      maybe=gray."
  - title: Home page redirect and placeholder pages
    done: true
    description: "Create src/routes/+page.server.ts to redirect / to
      /projects/{lastProjectId}/sessions using cookie for last project ID,
      falling back to /projects/all/sessions. Create placeholder pages:
      src/routes/projects/[projectId]/sessions/+page.svelte and
      src/routes/projects/[projectId]/active/+page.svelte with simple
      coming-soon text."
  - title: "Address Review Feedback: In `computeDisplayStatus`, when a dependency
      UUID is not found in the `planByUuid` map, `dependencyPlan?.status !==
      'done'` evaluates to `true` (since `undefined !== 'done'`), incorrectly
      marking the plan as `blocked`."
    done: true
    description: >-
      In `computeDisplayStatus`, when a dependency UUID is not found in the
      `planByUuid` map, `dependencyPlan?.status !== 'done'` evaluates to `true`
      (since `undefined !== 'done'`), incorrectly marking the plan as `blocked`.
      This happens for cross-project dependencies when using `getProjectBundle`
      (which only loads plans for one project). Both `getPlansForProject(db,
      projectId)` in single-project mode and `getPlanDetail()` are affected
      since they use single-project bundles.


      Suggestion: Either treat missing dependencies as resolved/unknown (e.g.,
      `return dependencyPlan != null && dependencyPlan.status !== 'done'`), or
      look up cross-project dependency plans individually when they're not found
      in the project-scoped map.


      Related file: src/lib/server/db_queries.ts:168-171
  - title: "Address Review Feedback: `getPlanDetail` loads the entire project's
      plans, tasks, dependencies, and tags via `getProjectBundle`, then enriches
      all plans, just to extract one."
    done: true
    description: >-
      `getPlanDetail` loads the entire project's plans, tasks, dependencies, and
      tags via `getProjectBundle`, then enriches all plans, just to extract one.
      For projects with many plans this is wasteful, though acceptable at
      current scale (<200 plans typical).


      Suggestion: Use a targeted query path for single-plan enrichment


      Related file: src/lib/server/db_queries.ts:326-335
  - title: "Address Review Feedback: The `$effect` block reads `data.plans` as a
      bare expression solely to create a reactive dependency, requiring an
      eslint-disable comment."
    done: true
    description: >-
      The `$effect` block reads `data.plans` as a bare expression solely to
      create a reactive dependency, requiring an eslint-disable comment.

      Suggestion: Use an afterNavigate hook instead and only clear the data when
      the projectId param has changed.

      Related file: src/routes/projects/[projectId]/plans/+page.svelte:26-33
  - title: "Address Review Feedback: `computeDisplayStatus()` now treats a missing
      dependency UUID as resolved."
    done: true
    description: >-
      `computeDisplayStatus()` now treats a missing dependency UUID as resolved.
      The new condition `dependencyPlan != null && dependencyPlan.status !==
      'done'` means a dependency row pointing at a deleted/stale/missing plan no
      longer blocks the owner plan. That contradicts tim's readiness semantics,
      which still treat missing dependencies as unresolved, so the web UI can
      show broken plans as `pending`/`in_progress` instead of `blocked` and
      misorder them in the Plans browser.


      Suggestion: Keep the cross-project backfill, but if a dependency still
      cannot be resolved after lookup, treat it as unresolved/blocking and add a
      regression test for missing dependency rows.


      Related file: src/lib/server/db_queries.ts:169-173
  - title: "Address Review Feedback: getPlanDetail loads all project assignments via
      getAssignmentEntriesByProject(db, plan.project_id) just to retrieve a
      single plan's assignment."
    done: true
    description: >-
      getPlanDetail loads all project assignments via
      getAssignmentEntriesByProject(db, plan.project_id) just to retrieve a
      single plan's assignment. For a detail view of a single plan, this loads
      every assignment for the entire project unnecessarily.


      Suggestion: Add a targeted getAssignmentByPlanUuid(db, planUuid) query to
      the assignment module rather than loading all project assignments.


      Related file: src/lib/server/db_queries.ts:412
  - title: Use proper routing for project plan view
    done: true
    description: >-
      Use proper routing for project plan view. Convert
      /projects[projectId]/plans/+page.svelte by a +layout.svelte component that
      only shows the sidebar and uses regular `a` tags to navigate.

      Add a sub route /projects/[projectId]/plans/[planId] under that to show
      the plan details. Then get rid of the unnecessary API route and just have
      the plan load in a page server load function for the new route. 
branch: web
changedFiles:
  - .agents/skills/svelte-core-bestpractices/SKILL.md
  - .agents/skills/svelte-core-bestpractices/references/$inspect.md
  - .agents/skills/svelte-core-bestpractices/references/@attach.md
  - .agents/skills/svelte-core-bestpractices/references/@render.md
  - .agents/skills/svelte-core-bestpractices/references/await-expressions.md
  - .agents/skills/svelte-core-bestpractices/references/bind.md
  - .agents/skills/svelte-core-bestpractices/references/each.md
  - .agents/skills/svelte-core-bestpractices/references/hydratable.md
  - .agents/skills/svelte-core-bestpractices/references/snippet.md
  - .agents/skills/svelte-core-bestpractices/references/svelte-reactivity.md
  - .npmrc
  - CLAUDE.md
  - README.md
  - components.json
  - docs/database.md
  - eslint.config.js
  - package.json
  - src/app.d.ts
  - src/app.html
  - src/lib/assets/favicon.svg
  - src/lib/components/FilterChips.svelte
  - src/lib/components/PlanDetail.svelte
  - src/lib/components/PlanRow.svelte
  - src/lib/components/PlansList.svelte
  - src/lib/components/PriorityBadge.svelte
  - src/lib/components/ProjectSidebar.svelte
  - src/lib/components/StatusBadge.svelte
  - src/lib/components/TabNav.svelte
  - src/lib/components/ui/accordion/accordion-content.svelte
  - src/lib/components/ui/accordion/accordion-item.svelte
  - src/lib/components/ui/accordion/accordion-trigger.svelte
  - src/lib/components/ui/accordion/accordion.svelte
  - src/lib/components/ui/accordion/index.ts
  - src/lib/components/ui/badge/badge.svelte
  - src/lib/components/ui/badge/index.ts
  - src/lib/components/ui/breadcrumb/breadcrumb-ellipsis.svelte
  - src/lib/components/ui/breadcrumb/breadcrumb-item.svelte
  - src/lib/components/ui/breadcrumb/breadcrumb-link.svelte
  - src/lib/components/ui/breadcrumb/breadcrumb-list.svelte
  - src/lib/components/ui/breadcrumb/breadcrumb-page.svelte
  - src/lib/components/ui/breadcrumb/breadcrumb-separator.svelte
  - src/lib/components/ui/breadcrumb/breadcrumb.svelte
  - src/lib/components/ui/breadcrumb/index.ts
  - src/lib/components/ui/button/button.svelte
  - src/lib/components/ui/button/index.ts
  - src/lib/components/ui/button-group/button-group-separator.svelte
  - src/lib/components/ui/button-group/button-group-text.svelte
  - src/lib/components/ui/button-group/button-group.svelte
  - src/lib/components/ui/button-group/index.ts
  - src/lib/components/ui/card/card-action.svelte
  - src/lib/components/ui/card/card-content.svelte
  - src/lib/components/ui/card/card-description.svelte
  - src/lib/components/ui/card/card-footer.svelte
  - src/lib/components/ui/card/card-header.svelte
  - src/lib/components/ui/card/card-title.svelte
  - src/lib/components/ui/card/card.svelte
  - src/lib/components/ui/card/index.ts
  - src/lib/components/ui/checkbox/checkbox.svelte
  - src/lib/components/ui/checkbox/index.ts
  - src/lib/components/ui/collapsible/collapsible-content.svelte
  - src/lib/components/ui/collapsible/collapsible-trigger.svelte
  - src/lib/components/ui/collapsible/collapsible.svelte
  - src/lib/components/ui/collapsible/index.ts
  - src/lib/components/ui/command/command-dialog.svelte
  - src/lib/components/ui/command/command-empty.svelte
  - src/lib/components/ui/command/command-group.svelte
  - src/lib/components/ui/command/command-input.svelte
  - src/lib/components/ui/command/command-item.svelte
  - src/lib/components/ui/command/command-link-item.svelte
  - src/lib/components/ui/command/command-list.svelte
  - src/lib/components/ui/command/command-loading.svelte
  - src/lib/components/ui/command/command-separator.svelte
  - src/lib/components/ui/command/command-shortcut.svelte
  - src/lib/components/ui/command/command.svelte
  - src/lib/components/ui/command/index.ts
  - src/lib/components/ui/data-table/data-table.svelte.ts
  - src/lib/components/ui/data-table/flex-render.svelte
  - src/lib/components/ui/data-table/index.ts
  - src/lib/components/ui/data-table/render-helpers.ts
  - src/lib/components/ui/dialog/dialog-close.svelte
  - src/lib/components/ui/dialog/dialog-content.svelte
  - src/lib/components/ui/dialog/dialog-description.svelte
  - src/lib/components/ui/dialog/dialog-footer.svelte
  - src/lib/components/ui/dialog/dialog-header.svelte
  - src/lib/components/ui/dialog/dialog-overlay.svelte
  - src/lib/components/ui/dialog/dialog-portal.svelte
  - src/lib/components/ui/dialog/dialog-title.svelte
  - src/lib/components/ui/dialog/dialog-trigger.svelte
  - src/lib/components/ui/dialog/dialog.svelte
  - src/lib/components/ui/dialog/index.ts
  - src/lib/components/ui/drawer/drawer-close.svelte
  - src/lib/components/ui/drawer/drawer-content.svelte
  - src/lib/components/ui/drawer/drawer-description.svelte
  - src/lib/components/ui/drawer/drawer-footer.svelte
  - src/lib/components/ui/drawer/drawer-header.svelte
  - src/lib/components/ui/drawer/drawer-nested.svelte
  - src/lib/components/ui/drawer/drawer-overlay.svelte
  - src/lib/components/ui/drawer/drawer-portal.svelte
  - src/lib/components/ui/drawer/drawer-title.svelte
  - src/lib/components/ui/drawer/drawer-trigger.svelte
  - src/lib/components/ui/drawer/drawer.svelte
  - src/lib/components/ui/drawer/index.ts
  - src/lib/components/ui/dropdown-menu/dropdown-menu-checkbox-group.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-checkbox-item.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-content.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-group-heading.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-group.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-item.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-label.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-portal.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-radio-group.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-radio-item.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-separator.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-shortcut.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-sub-content.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-sub-trigger.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-sub.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu-trigger.svelte
  - src/lib/components/ui/dropdown-menu/dropdown-menu.svelte
  - src/lib/components/ui/dropdown-menu/index.ts
  - src/lib/components/ui/field/field-content.svelte
  - src/lib/components/ui/field/field-description.svelte
  - src/lib/components/ui/field/field-error.svelte
  - src/lib/components/ui/field/field-group.svelte
  - src/lib/components/ui/field/field-label.svelte
  - src/lib/components/ui/field/field-legend.svelte
  - src/lib/components/ui/field/field-separator.svelte
  - src/lib/components/ui/field/field-set.svelte
  - src/lib/components/ui/field/field-title.svelte
  - src/lib/components/ui/field/field.svelte
  - src/lib/components/ui/field/index.ts
  - src/lib/components/ui/input/index.ts
  - src/lib/components/ui/input/input.svelte
  - src/lib/components/ui/input-group/index.ts
  - src/lib/components/ui/input-group/input-group-addon.svelte
  - src/lib/components/ui/input-group/input-group-button.svelte
  - src/lib/components/ui/input-group/input-group-input.svelte
  - src/lib/components/ui/input-group/input-group-text.svelte
  - src/lib/components/ui/input-group/input-group-textarea.svelte
  - src/lib/components/ui/input-group/input-group.svelte
  - src/lib/components/ui/label/index.ts
  - src/lib/components/ui/label/label.svelte
  - src/lib/components/ui/radio-group/index.ts
  - src/lib/components/ui/radio-group/radio-group-item.svelte
  - src/lib/components/ui/radio-group/radio-group.svelte
  - src/lib/components/ui/select/index.ts
  - src/lib/components/ui/select/select-content.svelte
  - src/lib/components/ui/select/select-group-heading.svelte
  - src/lib/components/ui/select/select-group.svelte
  - src/lib/components/ui/select/select-item.svelte
  - src/lib/components/ui/select/select-label.svelte
  - src/lib/components/ui/select/select-portal.svelte
  - src/lib/components/ui/select/select-scroll-down-button.svelte
  - src/lib/components/ui/select/select-scroll-up-button.svelte
  - src/lib/components/ui/select/select-separator.svelte
  - src/lib/components/ui/select/select-trigger.svelte
  - src/lib/components/ui/select/select.svelte
  - src/lib/components/ui/separator/index.ts
  - src/lib/components/ui/separator/separator.svelte
  - src/lib/components/ui/sheet/index.ts
  - src/lib/components/ui/sheet/sheet-close.svelte
  - src/lib/components/ui/sheet/sheet-content.svelte
  - src/lib/components/ui/sheet/sheet-description.svelte
  - src/lib/components/ui/sheet/sheet-footer.svelte
  - src/lib/components/ui/sheet/sheet-header.svelte
  - src/lib/components/ui/sheet/sheet-overlay.svelte
  - src/lib/components/ui/sheet/sheet-portal.svelte
  - src/lib/components/ui/sheet/sheet-title.svelte
  - src/lib/components/ui/sheet/sheet-trigger.svelte
  - src/lib/components/ui/sheet/sheet.svelte
  - src/lib/components/ui/sidebar/constants.ts
  - src/lib/components/ui/sidebar/context.svelte.ts
  - src/lib/components/ui/sidebar/index.ts
  - src/lib/components/ui/sidebar/sidebar-content.svelte
  - src/lib/components/ui/sidebar/sidebar-footer.svelte
  - src/lib/components/ui/sidebar/sidebar-group-action.svelte
  - src/lib/components/ui/sidebar/sidebar-group-content.svelte
  - src/lib/components/ui/sidebar/sidebar-group-label.svelte
  - src/lib/components/ui/sidebar/sidebar-group.svelte
  - src/lib/components/ui/sidebar/sidebar-header.svelte
  - src/lib/components/ui/sidebar/sidebar-input.svelte
  - src/lib/components/ui/sidebar/sidebar-inset.svelte
  - src/lib/components/ui/sidebar/sidebar-menu-action.svelte
  - src/lib/components/ui/sidebar/sidebar-menu-badge.svelte
  - src/lib/components/ui/sidebar/sidebar-menu-button.svelte
  - src/lib/components/ui/sidebar/sidebar-menu-item.svelte
  - src/lib/components/ui/sidebar/sidebar-menu-skeleton.svelte
  - src/lib/components/ui/sidebar/sidebar-menu-sub-button.svelte
  - src/lib/components/ui/sidebar/sidebar-menu-sub-item.svelte
  - src/lib/components/ui/sidebar/sidebar-menu-sub.svelte
  - src/lib/components/ui/sidebar/sidebar-menu.svelte
  - src/lib/components/ui/sidebar/sidebar-provider.svelte
  - src/lib/components/ui/sidebar/sidebar-rail.svelte
  - src/lib/components/ui/sidebar/sidebar-separator.svelte
  - src/lib/components/ui/sidebar/sidebar-trigger.svelte
  - src/lib/components/ui/sidebar/sidebar.svelte
  - src/lib/components/ui/skeleton/index.ts
  - src/lib/components/ui/skeleton/skeleton.svelte
  - src/lib/components/ui/sonner/index.ts
  - src/lib/components/ui/sonner/sonner.svelte
  - src/lib/components/ui/spinner/index.ts
  - src/lib/components/ui/spinner/spinner.svelte
  - src/lib/components/ui/switch/index.ts
  - src/lib/components/ui/switch/switch.svelte
  - src/lib/components/ui/table/index.ts
  - src/lib/components/ui/table/table-body.svelte
  - src/lib/components/ui/table/table-caption.svelte
  - src/lib/components/ui/table/table-cell.svelte
  - src/lib/components/ui/table/table-footer.svelte
  - src/lib/components/ui/table/table-head.svelte
  - src/lib/components/ui/table/table-header.svelte
  - src/lib/components/ui/table/table-row.svelte
  - src/lib/components/ui/table/table.svelte
  - src/lib/components/ui/textarea/index.ts
  - src/lib/components/ui/textarea/textarea.svelte
  - src/lib/components/ui/toggle/index.ts
  - src/lib/components/ui/toggle/toggle.svelte
  - src/lib/components/ui/toggle-group/index.ts
  - src/lib/components/ui/toggle-group/toggle-group-item.svelte
  - src/lib/components/ui/toggle-group/toggle-group.svelte
  - src/lib/components/ui/tooltip/index.ts
  - src/lib/components/ui/tooltip/tooltip-content.svelte
  - src/lib/components/ui/tooltip/tooltip-portal.svelte
  - src/lib/components/ui/tooltip/tooltip-provider.svelte
  - src/lib/components/ui/tooltip/tooltip-trigger.svelte
  - src/lib/components/ui/tooltip/tooltip.svelte
  - src/lib/hooks/is-mobile.svelte.ts
  - src/lib/index.ts
  - src/lib/server/db_queries.test.ts
  - src/lib/server/db_queries.ts
  - src/lib/server/init.ts
  - src/lib/server/plans_browser.test.ts
  - src/lib/server/plans_browser.ts
  - src/lib/stores/project.svelte.ts
  - src/lib/utils.ts
  - src/rmfilter/config.ts
  - src/routes/+layout.server.ts
  - src/routes/+layout.svelte
  - src/routes/+page.server.ts
  - src/routes/+page.svelte
  - src/routes/layout.css
  - src/routes/projects/[projectId]/+layout.server.ts
  - src/routes/projects/[projectId]/+layout.svelte
  - src/routes/projects/[projectId]/active/+page.svelte
  - src/routes/projects/[projectId]/plans/+layout.server.ts
  - src/routes/projects/[projectId]/plans/+layout.svelte
  - src/routes/projects/[projectId]/plans/+page.svelte
  - src/routes/projects/[projectId]/plans/[planId]/+page.server.ts
  - src/routes/projects/[projectId]/plans/[planId]/+page.svelte
  - src/routes/projects/[projectId]/sessions/+page.svelte
  - src/tim/commands/import/linear_plan_structure.test.ts
  - src/tim/commands/import/plan_file_validation.test.ts
  - src/tim/commands/validate.ts
  - src/tim/configSchema.ts
  - src/tim/db/json_import.ts
  - src/tim/executors/build.test.ts
  - src/tim/executors/build.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/codex_cli.ts
  - src/tim/executors/schemas.test.ts
  - src/tim/executors/schemas.ts
  - src/tim/formatters/review_output_schema.ts
  - src/tim/mcp/generate_mode.test.ts
  - src/tim/planSchema.ts
  - src/tim/plans/plan_state_utils.ts
  - src/tim/tim.ts
  - src/tim/tools/schemas.ts
  - static/robots.txt
  - svelte.config.js
  - tim-gui/TimGUI/PlansView.swift
  - vite.config.ts
tags: []
---

Set up SvelteKit server initialization, shared layout with tab navigation and project sidebar, DB query helpers with server-side display status computation, and the Plans browser view with filtering, sorting, search, and detail display. This is the foundation that all other child plans build on.

## Research

### 1. Current SvelteKit State

The SvelteKit app is freshly scaffolded (commit "start web interface") with minimal structure:
- **Root layout** (`src/routes/+layout.svelte`): Imports `layout.css` (which just does `@import 'tailwindcss'`), applies favicon, renders children
- **Home page** (`src/routes/+page.svelte`): Default SvelteKit welcome text
- **No components**, no server routes, no API endpoints, no `src/lib/server/` directory yet
- **Config**: `svelte.config.js` uses `@sveltejs/adapter-node` with aliases `$tim → src/tim`, `$common → src/common`; runes enabled for all non-node_modules files
- **Vite**: Tailwind CSS v4 via `@tailwindcss/vite`, vitest configured with server-side test project (client tests commented out)
- **TypeScript**: Strict mode, `app.d.ts` has empty interface stubs
- **Testing**: `bun run test:web` runs vitest; `requireAssertions: true` in vitest config

### 2. Database Layer

All DB operations are **synchronous** via `bun:sqlite` with WAL mode. Key characteristics:
- **Singleton access**: `getDatabase()` returns a cached instance, initializes on first call
- **Default path**: `getDefaultDatabasePath()` uses `getTimConfigRoot()` → `~/.config/tim/tim.db`
- **Pragmas**: WAL mode, foreign keys ON, 5s busy timeout, NORMAL synchronous
- **Migrations**: Automatic via `runMigrations(db)` with schema versioning

#### Available Query Functions (relevant to Plans browser)

**Projects:**
- `listProjects(db) → Project[]` — all projects with id, repository_id, remote_url, last_git_root, highest_plan_id
- `getProjectById(db, id) → Project | null`

**Plans:**
- `getPlansByProject(db, projectId) → PlanRow[]` — all plans for a project (uuid, plan_id, title, goal, status, priority, parent_uuid, epic, filename, created_at, updated_at, etc.)
- `getPlanByUuid(db, uuid) → PlanRow | null`

**Tasks:**
- `getPlanTasksByProject(db, projectId) → PlanTaskRow[]` — all tasks across project (plan_uuid, task_index, title, description, done)
- `getPlanTasksByUuid(db, planUuid) → PlanTaskRow[]`

**Dependencies:**
- `getPlanDependenciesByProject(db, projectId) → PlanDependencyRow[]` — (plan_uuid, depends_on_uuid)

**Tags:**
- `getPlanTagsByProject(db, projectId) → PlanTagRow[]` — (plan_uuid, tag)

**Workspaces:**
- `findWorkspacesByProjectId(db, projectId) → WorkspaceRow[]` — workspace_path, branch, plan_id, plan_title, is_primary, updated_at
- `getWorkspaceLock(db, workspaceId) → WorkspaceLockRow | null`

**Assignments:**
- `getAssignmentEntriesByProject(db, projectId) → Record<uuid, AssignmentEntry>` — rich join with workspace data

### 3. Plan Schema and Status Model

From `planSchema.ts`, the core `PlanSchema` type includes:
- `id` (numeric), `uuid`, `title`, `goal`, `details`, `status`, `priority`
- `parent` (numeric ID), `dependencies` (numeric IDs[]), `epic` (boolean)
- `tasks` (array of `{title, description, done}`)
- `tags`, `issue` (URLs[]), `assignedTo`, `branch`, `createdAt`, `updatedAt`

**Statuses**: `pending`, `in_progress`, `done`, `cancelled`, `deferred`, `needs_review`
- Status preprocessing: "complete"/"completed" → "done"
- Priority values: `low`, `medium`, `high`, `urgent`, `maybe`

**Display Status Computation** (from parent plan 227 research):
The web UI needs a "display status" that adds `blocked` and `recently_done` on top of raw statuses:
- `blocked`: Plan is pending/in_progress but has unresolved dependencies (deps not all done)
- `recently_done`: Status is done and updatedAt is within last 7 days
- Otherwise: show raw status

### 4. Ready Plans / Filtering Logic

From `ready_plans.ts`:
- `isReadyPlan()`: Status must be pending/in_progress AND all dependencies must be done
- `filterAndSortReadyPlans()`: Filters by priority, pendingOnly, epicId, tags, limit; sorts by priority/id/title/created/updated
- Priority sort order: urgent (5) > high (4) > medium (3) > low (2) > maybe (1)
- Plans without tasks ARE considered ready (by design)

### 5. Plan Display Utilities

From `plan_display.ts`:
- `buildPlanContext()`: Assembles markdown with plan metadata, goal, issues, tasks, details
- `resolvePlan()`: Resolves plan argument (number or path) to file and reads it
- `formatExistingTasks()`: Formats task list with done/pending indicators

### 6. Configuration Loading

From `configSchema.ts` and config loading:
- `loadEffectiveConfig(configPath?)`: Loads and merges local + main config
- `resolvePlanPathContext(config)`: Resolves gitRoot and task directory paths
- `getTimConfigRoot()`: XDG-aware config dir (`~/.config/tim/`)
- Headless config section: `headless.url` for WebSocket URL (default port 8123)

### 7. Key Patterns to Follow

- **Server-only modules**: Must use `$lib/server/` convention — bun:sqlite cannot be imported client-side
- **Synchronous DB**: All DB calls are sync (bun:sqlite native API), no await needed
- **Svelte 5 runes**: Use `$state()`, `$derived()`, `$effect()` for reactivity
- **Tailwind CSS v4**: No config file, configured via Vite plugin + `@import 'tailwindcss'`
- **Testing**: Vitest with `requireAssertions: true`, real DB fixtures preferred over mocks

## Implementation Guide

### Architecture Overview

```
Browser ←→ SvelteKit Routes ←→ Server-side Query Helpers ←→ SQLite DB
```

For Plan 228 (this plan), the architecture is straightforward: server-side rendered pages with SvelteKit load functions querying the database. No SSE or WebSocket needed — those come in Plan 229.

### Step 1: Server Initialization & Shared Context

**File: `src/lib/server/init.ts`**

Create a lazy-init singleton that provides shared server context:
1. Call `loadEffectiveConfig()` to load tim config
2. Call `resolvePlanPathContext(config)` to get gitRoot and task directory
3. Call `getDatabase()` to get the DB singleton (it auto-initializes)
4. Call `syncAllPlansToDb()` to ensure DB is up-to-date with plan files on server start
5. Export a `getServerContext()` function that returns `{ config, gitRoot, tasksDir, db }` — lazily initialized on first call

Import from `$tim/configSchema.ts` for config loading, `$tim/db/database.ts` for DB access, `$tim/db/plan_sync.ts` for syncing. Use the `$tim` and `$common` aliases.

The lazy-init pattern is important because SvelteKit may import server modules during build/check without actually running them. Wrap initialization in a function that only runs on first invocation.

### Step 2: Server-Side DB Query Helpers

**File: `src/lib/server/db_queries.ts`**

Create helper functions that compose the existing DB CRUD functions into web-UI-ready queries:

1. **`getProjectsWithMetadata(db)`** — Call `listProjects(db)`, then for each project call `getPlansByProject(db, projectId)` to compute plan counts by status. Return projects with enriched metadata (plan count, active plan count, etc.). Consider using a single SQL query with COUNT/GROUP BY for efficiency if the existing functions don't cover it.

2. **`getPlansForProject(db, projectId?)`** — When `projectId` is provided, filter to that project; when omitted (for `all` mode), query across all projects with a single unfiltered query. Plan rows include `project_id` so the UI can show project context in `all` mode. Combine:
   - `getPlansByProject(db, projectId)` for plan rows
   - `getPlanTasksByProject(db, projectId)` for tasks (group by plan_uuid)
   - `getPlanDependenciesByProject(db, projectId)` for dependencies
   - `getPlanTagsByProject(db, projectId)` for tags
   - Compute display status for each plan:
     - If status is pending/in_progress and has dependencies where not all are done → `blocked`
     - If status is done and updatedAt within 7 days → `recently_done`
     - Otherwise → raw status
   - Return enriched plan objects with tasks, tags, deps, display status, task completion counts

3. **`getPlanDetail(db, projectId, planUuid)`** — Get single plan with all related data (tasks, dependencies with their titles/statuses for display, tags, assignment info via `getAssignmentEntriesByProject`).

4. **`getWorkspaceSummaryForProject(db, projectId)`** — For Active Work tab (Plan 230) but useful to stub now. Call `findWorkspacesByProjectId()` and enrich with lock info.

### Step 3: Shared Layout and Navigation

**File: `src/routes/+layout.svelte`** (modify existing)

Replace the minimal layout with an app shell:
- Fixed header bar with app title ("tim") and tab navigation
- Three tabs: Sessions, Active Work, Plans — tab links use the project helper to build `/projects/{lastProjectId}/{tab}` URLs
- Highlight active tab based on current route using `$page.url.pathname`
- Main content area below header renders `{@render children()}`
- Use Tailwind for styling: `flex`, `bg-gray-50`, etc.

**File: `src/routes/+layout.server.ts`** (new)

Root layout server load function:
- Call `getServerContext()` to ensure initialization
- Load project list via `getProjectsWithMetadata(db)`
- Return `{ projects }` as page data — available to all routes

**File: `src/routes/projects/[projectId]/+layout.server.ts`** (new)

Project-scoped layout load:
- Read `projectId` param (numeric ID or `all`)
- Validate project exists (if numeric)
- Return `{ projectId, project }` for child routes

**File: `src/routes/projects/[projectId]/+layout.svelte`** (new)

Project-scoped layout:
- Renders project sidebar + content area side by side
- Sidebar shows project list, highlights current project
- Saves selected project to cookie via helper (set from server-side layout load or via a lightweight POST/cookie-set action)

**File: `src/lib/components/TabNav.svelte`** (new)

Tab navigation component:
- Props: `currentPath` (string), `projectId` (string)
- Renders horizontal tab bar with links to `/projects/{projectId}/{tab}`
- Highlights active tab
- Uses `<a>` tags for SvelteKit navigation

### Step 4: Route-Based Project Selection

**Route structure**: `/projects/[projectId]/plans`, `/projects/[projectId]/active`, `/projects/[projectId]/sessions`

The `[projectId]` param can be a numeric project ID or `all` to show unfiltered data. This gives us deep-linkable, bookmarkable URLs.

**File: `src/lib/stores/project.svelte.ts`** (new)

Helper for "most recently used project" tracking:
- `setLastProjectId(id: number)` — saves to a cookie (so the server can read it for redirects)
- `getLastProjectId(cookies): number | null` — reads from cookie
- `projectUrl(projectId: number | 'all', tab: string): string` — helper to build `/projects/{id}/{tab}` URLs
- When generating links to project-scoped routes (e.g., from the root layout or tab nav), default to the last-used project ID from the cookie, falling back to `all`

**Route group: `src/routes/projects/[projectId]/`**

- `+layout.server.ts` — reads `projectId` param, loads project data (or all projects if `all`), passes to children
- `+layout.svelte` — provides project context to child routes, includes project sidebar
- Child routes: `plans/+page.svelte`, `plans/+page.server.ts`, etc.

The project sidebar links navigate between `/projects/{id}/{currentTab}` URLs. Clicking a project updates the route; the project-scoped layout server load sets the cookie.

### Step 5: Plans Browser — Server Load

**File: `src/routes/projects/[projectId]/plans/+page.server.ts`** (new)

Load function:
- Get `projectId` from parent layout data (already parsed from route param)
- Call `getPlansForProject(db, projectId)` to get enriched plan list
- Return `{ plans }`

### Step 6: Plans Browser — UI Components

**File: `src/routes/projects/[projectId]/plans/+page.svelte`** (new)

Main plans page with two-column layout (project sidebar is in the parent `[projectId]` layout):
1. **Plan list** (left) — filtered, sorted, searchable plan list
2. **Plan detail** (right) — selected plan's full details

Use `$state()` for local UI state (search query, selected filters, sort option, selected plan).

**File: `src/lib/components/ProjectSidebar.svelte`** (new)

Shared project sidebar (reused by Active Work in Plan 230):
- Props: `projects` (array), `selectedProjectId` (number)
- Renders project list with last 2 path components as display name (matching macOS app pattern)
- Click handler updates selected project (navigates with search param)

**File: `src/lib/components/PlansList.svelte`** (new)

Plan list with filtering and sorting:
- Props: `plans` (enriched plan array)
- Local state: `searchQuery`, `statusFilters` (Set), `sortField`, `selectedPlanId`
- Search: case-insensitive match on title + goal
- Status filter chips: In Progress, Blocked, Pending, Needs Review, Recently Done, Done, Cancelled, Deferred + Reset button
- Sort picker: Recently Updated, Plan #, Priority
- Group plans by display status, ordered by actionability: In Progress → Blocked → Pending → Needs Review → Recently Done → Done → Cancelled → Deferred
- Each group is collapsible; Done, Cancelled, and Deferred groups start collapsed by default
- Client-side filtering/sorting since plan counts per project are manageable (typically <200)

**File: `src/lib/components/PlanRow.svelte`** (new)

Individual plan row in the list:
- Props: `plan`, `selected` (boolean)
- Display: plan #, title, priority badge, status badge, task completion (e.g., "3/5")
- Click to select

**File: `src/lib/components/FilterChips.svelte`** (new)

Status filter chip bar:
- Props: `activeFilters` (Set of display statuses), `onToggle` callback
- Renders chip per status with count, plus Reset/All button
- Multi-select: clicking a chip toggles it

**File: `src/lib/components/PlanDetail.svelte`** (new)

Plan detail display:
- Props: `plan` (enriched plan object with tasks, deps, tags)
- Sections: header (# + title), status/priority badges, goal, tasks (expanded by default with title + description + checkmark for done), dependencies (with status indication — resolved vs unresolved), assigned workspace, parent plan link, tags, timestamps (created, updated), epic indicator
- Dependencies show plan # + title + status, with visual indication of whether resolved (e.g., strikethrough or muted for done deps, amber/red for blocking deps). Dependency links are clickable — clicking navigates to that plan in the detail pane

**File: `src/lib/components/StatusBadge.svelte`** (new)

Reusable status badge:
- Props: `status` (display status string)
- Color mapping: in_progress → blue, blocked → yellow/amber, pending → gray, done/recently_done → green, cancelled → red, deferred → purple, needs_review → orange

**File: `src/lib/components/PriorityBadge.svelte`** (new)

Reusable priority badge:
- Props: `priority` (string)
- Color mapping: urgent → red, high → orange, medium → yellow, low → blue, maybe → gray

### Step 7: Placeholder Pages for Sessions and Active Work

**File: `src/routes/projects/[projectId]/sessions/+page.svelte`** (new)

Simple placeholder: "Sessions view — coming soon" centered text. Will be implemented in Plan 229.

**File: `src/routes/projects/[projectId]/active/+page.svelte`** (new)

Simple placeholder: "Active Work dashboard — coming soon" centered text. Will be implemented in Plan 230.

### Step 8: Home Page Redirect

**File: `src/routes/+page.server.ts`** (new)

Redirect `/` to `/projects/{lastProjectId}/sessions` (or `/projects/all/sessions` if no history). Use SvelteKit's `redirect(302, url)` in the load function. Read last project ID from a cookie (set by the project-scoped layout when the user selects a project). This way the server can redirect in one hop without needing client-side JS.

### Step 9: Tests

**File: `src/lib/server/db_queries.test.ts`** (new)

Test the server-side query helpers:
- Set up a test database with fixture data (projects, plans with various statuses, dependencies, tasks, tags)
- Test `getProjectsWithMetadata()` returns correct plan counts
- Test `getPlansForProject()`:
  - Returns all plans with tasks, tags, deps
  - Correctly computes `blocked` display status (plan with unresolved dep)
  - Correctly computes `recently_done` display status
  - Plans without dependencies show raw status
- Test `getPlanDetail()` returns full plan data with dependency titles/statuses
- Use real DB (no mocking per project guidelines), create temp DB with `openDatabase()`

### Testing Strategy

- **DB query helpers**: Real DB with fixture data, test display status computation, filtering
- **Components**: Could add component tests later but prioritize server-side logic tests
- **Integration**: Manual testing with `bun run dev` against real tim data

### Manual Testing Steps

1. Start dev server with `bun run dev`
2. Verify tab navigation works (Sessions, Active Work, Plans links)
3. Select different projects in sidebar, verify plan list updates
4. Test search field filters plans by title/goal
5. Test status filter chips (toggle, multi-select, reset)
6. Test sort picker (Recently Updated, Plan #, Priority)
7. Click a plan row, verify detail pane shows full information
8. Verify blocked plans show correctly (have unresolved deps)
9. Verify recently done plans show in their own group

### Potential Gotchas

- **SQLite in SvelteKit**: bun:sqlite is synchronous and server-only. All DB imports must be in `$lib/server/` or `+page.server.ts` files. Importing from client code will fail at build time.
- **Lazy initialization**: The server context must be lazily initialized because SvelteKit may import server modules during `svelte-kit sync` or type checking without a running server.
- **Plan file vs DB**: The DB is a mirror of plan files. On server start, `syncAllPlansToDb()` ensures the DB is current. For this plan (read-only), we only need to read from DB.
- **Display status computation**: Must join plan data with dependency data to compute "blocked" status. This is a derived status, not stored in DB.
- **Large project performance**: Client-side filtering/sorting should be fine for typical plan counts (<200 per project). If a project has thousands of plans, we'd need server-side pagination (defer to future).
- **Tailwind v4**: No `tailwind.config.js` file. Custom theming uses CSS variables in `layout.css` via `@theme` directive if needed.

## Current Progress
### Current State
- All 16 tasks complete. Plan is done.
- 19 passing tests (13 DB query helpers + 4 plans browser server + 2 plans browser routing)
- `bun run check` passes cleanly
### Completed (So Far)
- Tasks 1-10: Core infrastructure, DB queries, layout, navigation, plans browser, badges, placeholders
- Task 11: Fixed computeDisplayStatus to handle missing cross-project dependencies correctly — enrichPlansWithContext now backfills missing dependency plans from DB
- Task 12: Optimized getPlanDetail to use targeted single-plan queries instead of loading full project bundle
- Task 13: Replaced $effect hack with afterNavigate hook for cleaner project-switch detection
- Task 14: Fixed computeDisplayStatus to treat missing dependency UUIDs as blocking (changed `dependencyPlan != null &&` to `dependencyPlan == null ||`), added regression test
- Task 15: Replaced getAssignmentEntriesByProject with targeted getAssignmentEntry in getPlanDetail; overrides status/planStatus with live plan status to avoid stale assignment row data
- Task 16: Proper SvelteKit routing for plan detail — plans layout splits list/detail, sub-route `/plans/[planId]` loads detail server-side, API route removed. Fixed cross-project dependency links to use owning project ID.
### Remaining
- None
### Next Iteration Guidance
- Plan 229 (Sessions) and Plan 230 (Active Work) can now build on this infrastructure
- The `all` mode shows project names on plan rows and in detail view — reuse projectNamesByPlanProjectId pattern
- Known pre-existing issue: init.ts doesn't run syncAllPlansToDb on startup
### Decisions / Changes
- Added projectId to ServerContext return type (not in original task description but needed by query helpers)
- getProjectsWithMetadata uses aggregate SQL instead of N+1 per-project queries
- enrichPlansWithContext exposes intermediate lookup maps to avoid duplicate work in getPlanDetail
- enrichPlansWithContext now accepts db parameter and backfills missing cross-project dependency plans automatically
- syncAllPlansToDb called with prune: true to clean stale DB entries on startup
- TabNav uses $page.params.projectId as source of truth instead of cookie-based lastProjectId from root layout
- Child [projectId] layout uses `await parent()` to share data from root layout instead of duplicate DB query
- Invalid/nonexistent project IDs redirect to /projects/all/{tab} rather than silently coercing
- Cookie set to httpOnly: true since it's only read server-side
- plans_browser.ts abstraction layer between route handlers and db_queries keeps routes thin and testable
- {#key data.projectId} wraps PlansList to force re-mount on project switch (resets filter/search state)
- tsconfig.json restored original lib: ["ESNext"] setting to avoid ReadableStream type conflicts with Bun types; added config files to include for ESLint but excluded them from tsconfig.build.json for tsc
- Used Object.hasOwn() instead of `in` operator for prototype-safe status counting
- getPlanDetail uses getAssignmentEntry (targeted) but overrides status/planStatus with the live plan status to preserve semantics from the previous getAssignmentEntriesByProject approach
- Plan detail loaded server-side via sub-route instead of client-side API fetch; redirects to owning project if accessed under wrong projectId
- EnrichedPlanDependency includes projectId so dependency/parent links point directly to owning project
### Lessons Learned
- When enrichPlans builds internal lookup maps (planByUuid), callers that need those maps too should share them — otherwise you get bugs where a single-plan map causes all deps to appear unresolved
- The vitest include glob in vite.config.ts needed adjustment (src/lib** not src/lib/) to match files in src/lib/server/
- In Svelte 5, `$derived(() => { ... })` wraps the function object itself, not the return value — use `$derived.by(() => { ... })` for multi-statement derivations
- SvelteKit child layouts should use `await parent()` to access data already loaded by parent layouts instead of re-querying
- Tab detection via `pathname.includes()` is fragile — match against specific path segment positions instead
- SvelteKit reuses page components across param-only navigations — local $state persists. Use {#key} blocks or $effect to reset state when route params change.
- tsconfig.json lib setting matters: adding "DOM" alongside Bun types causes ReadableStream async iteration type conflicts. Keep "ESNext" only for Bun projects.
- Config files (vite.config.ts, eslint.config.js, svelte.config.js) should be in tsconfig include for ESLint parsing but excluded from tsconfig.build.json to avoid tsc type errors
- When optimizing from bulk to targeted queries, transitive dependencies need their own plans loaded too — a two-layer resolution strategy (explicit + fallback in enrichment) handles edge cases but needs documenting
- Cross-project dependency handling requires consistent resolution across list and detail views — skipping unknown deps silently creates list/detail status disagreements
- When replacing a bulk query with a targeted one, verify the semantics match — the targeted getAssignmentEntry didn't join the plan table, causing stale assignment.status values. The fix was to override status fields with the live plan data already available in the caller.
### Risks / Blockers
- None
