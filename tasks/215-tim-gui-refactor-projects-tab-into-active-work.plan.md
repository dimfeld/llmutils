---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: Refactor Projects tab into Active Work dashboard"
goal: Transform the current Projects tab into a focused 'Active Work' dashboard
  that shows only in-progress plans and recently-used workspaces, providing a
  quick status overview of what's currently happening in each project
id: 215
uuid: 79f51dfc-c14b-4bd1-b129-324090af5a89
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-02-25T08:32:07.431Z
promptsGeneratedAt: 2026-02-25T08:32:07.431Z
createdAt: 2026-02-25T08:31:24.257Z
updatedAt: 2026-02-26T08:40:46.518Z
tasks:
  - title: Rename Projects tab to Active Work in top navigation
    done: true
    description: In ContentView.swift, rename the "Projects" segment in the
      segmented picker to "Active" or "Active Work". Update the ViewSelection
      enum and any related labels. The tab should convey that this is a live
      status dashboard, not a full project browser.
  - title: Filter workspaces to show only recently active ones
    done: true
    description: In ProjectTrackingStore.swift, update the workspace fetch/filter
      logic to only show workspaces that are either currently locked, marked as
      primary, or have been used recently (e.g. within the last 24-48 hours
      based on assignment timestamps or lock activity). Add a toggle or link
      like "Show all workspaces" that expands to the full list if needed. This
      dramatically reduces the workspace section height in most cases.
  - title: Filter plans section to show only in-progress and blocked plans
    done: true
    description: Replace the current filter chips UI in PlansSection with a
      hardcoded filter showing only inProgress and blocked plans. Remove the
      FilterChipsView from this view (it will be reused in the dedicated Plans
      browser tab later). If there are no active plans, show an empty state like
      "No active plans — browse all plans to get started" with a link/action to
      navigate to the Plans tab (once it exists).
  - title: Remove redundant Available status badges from workspace rows
    done: true
    description: In WorkspaceRowView, stop showing the "Available" status
      text/badge. Only show status indicators for non-default states (Primary,
      Locked). The absence of a badge implies available. This reduces visual
      noise.
  - title: Visually link workspaces to their assigned plans
    done: true
    description: When a workspace has an assigned plan (via assignedPlanUuid), show
      the plan title or number inline on the workspace row. This connects the
      two sections and makes it immediately clear what each workspace is working
      on. Consider whether the workspace and plan sections should be merged into
      a single "active work" list when item counts are small.
  - title: Add empty state handling for the active work dashboard
    done: true
    description: Handle the case where a project has no in-progress plans and no
      recently active workspaces. Show a helpful empty state message that guides
      the user to the Plans tab to pick up work. Also handle the case where
      there are active plans but no workspaces, and vice versa.
changedFiles:
  - tim-gui/AGENTS.md
  - tim-gui/TimGUI/ContentView.swift
  - tim-gui/TimGUI/ProjectTrackingModels.swift
  - tim-gui/TimGUI/ProjectTrackingStore.swift
  - tim-gui/TimGUI/ProjectsView.swift
  - tim-gui/TimGUITests/ProjectTrackingModelTests.swift
  - tim-gui/TimGUITests/ProjectTrackingStoreTests.swift
tags:
  - tim-gui
---

## Current Progress
### Current State
- All 6 tasks are complete. The Active Work dashboard is fully implemented with workspace filtering, plan linking, and all supporting infrastructure.
- Post-review autofix iteration is complete for the selected findings: empty-state gating now matches active-work filtering, workspace toggle styling follows accent color theming, and ISO8601 parsing avoids per-row formatter allocation.
- Follow-up review polish is complete: dashboard-level and section-level workspace recency checks now share one reference `Date`, the workspace plan-title condition is simplified for readability, and retained plan-filter helpers are explicitly documented as intentional for the upcoming Plans browser tab.
- Final consistency cleanup is complete: `PlansSection` now receives the parent-captured `now` from `ProjectDetailView` instead of creating its own `Date`, matching the `WorkspacesSection` pattern.
- Final stabilization pass confirmed the implementation is complete for this plan scope; no additional product-code changes are pending.

### Completed (So Far)
- Task 1: Renamed `AppTab.projects` to `AppTab.activeWork` with raw value "Active Work" in ContentView.swift
- Task 2: `TrackedWorkspace` has `updatedAt: Date?` field fetched from DB; `isRecentlyActive(now:)` filters to locked/primary/updated-within-48h; `WorkspacesSection` shows active-only by default with "Show all workspaces (N total)" toggle; `.id(selectedProjectId)` resets toggle on project switch
- Task 3: Removed FilterChipsView from PlansSection; now hardcodes filter to `.inProgress` and `.blocked` plans only using `PlanDisplayStatus.isActiveWork`. Shows "No active plans — browse all plans to get started" empty state.
- Task 4: WorkspaceRowView no longer shows icon or label for `.available` status. Uses unconditional `.frame(width: 14)` for alignment consistency across mixed status rows.
- Task 5: WorkspaceRowView shows `#planId` prefix before plan title when a workspace has an assigned plan, connecting workspaces to their plans visually
- Task 6: ProjectDetailView shows full empty state when no workspaces and no active plans. PlansSection shows section-level empty state when workspaces exist but no active plans.
- Review fix: ProjectDetailView now computes empty-state visibility from recently active workspaces (`isRecentlyActive`) instead of all workspaces, so stale-only workspaces no longer suppress the "No Active Work" state.
- Review fix: WorkspacesSection toggle text now uses `Color.accentColor` instead of hardcoded `.blue` to respect user/system accent settings.
- Review fix: `parseISO8601Date` now reuses two `ISO8601DateFormatter` instances per fetch operation (workspaces/plans) instead of allocating formatters on each parse call.
- Review fix: Active-work dashboard tests now assert against recently-active workspace presence, include a stale-workspace regression case, and include a recently-active workspace visibility case.
- Review fix: `ProjectDetailView` now passes its captured `now` into `WorkspacesSection`, removing a theoretical 48-hour boundary mismatch between parent gating and child filtering.
- Review fix: `ProjectDetailView` now passes its captured `now` into `PlansSection`, removing the remaining local `Date()` call in plans display status rendering.
- Review fix: Workspace row assigned-plan visibility check now uses `!(planTitle?.isEmpty ?? true)` for clearer intent.
- Review fix: Preserved plan-filter infrastructure (`activeFilters`, `filteredPlans`, `defaultPlanFilters`, `shouldShowPlan`) is now explicitly marked as intentional carry-forward for the planned dedicated Plans browser tab.
- Progress notes are now aligned with the final state of this plan and include the boundary-consistency and preserved-infrastructure rationale for future follow-up work.

### Remaining
- None

### Next Iteration Guidance
- None

### Decisions / Changes
- Added `isActiveWork` computed property on `PlanDisplayStatus` as a shared filter predicate used by both views and tests
- FilterChipsView/FilterChip structs were fully removed from ProjectsView.swift (will be recreated for future Plans browser tab)
- Active plans list is computed once in ProjectDetailView and passed to PlansSection to avoid duplicate filtering
- Empty state text is informational only (no navigation CTA) since the Plans browser tab doesn't exist yet
- Workspace recency uses 48-hour cutoff on `updated_at` field, with locked/primary overriding regardless of date
- Date parsing extracted into shared `parseISO8601Date()` with local formatters (not global) for thread safety
- WorkspacesSection uses `.id(selectedProjectId)` to reset `@State` toggle when switching projects
- ProjectDetailView empty-state condition is based on "recently active workspaces OR active plans", aligning the top-level dashboard state with the section-level filtering contract.
- Date parsing keeps formatter lifecycle local to each fetch function call to avoid shared formatter thread-safety risks while still avoiding per-row formatter allocations.
- `ProjectDetailView` and `WorkspacesSection` now share a single captured `now` value so dashboard-level and section-level recency logic cannot diverge at time-window boundaries.
- `PlansSection` now also uses the parent-provided `now`, making all active-work time-based UI decisions in `ProjectDetailView` consistent across both sections.
- Retained plan-filter helpers are documented in code as intentional future-tab infrastructure, avoiding accidental "dead code" ambiguity while preserving existing tests.

### Lessons Learned
- When removing status icons conditionally in SwiftUI, use an unconditional `.frame(width:)` wrapper to maintain row alignment across mixed states
- Tests should call production computed properties (e.g., `status.isActiveWork`) rather than duplicating the logic in local helpers — otherwise the tests won't catch regressions in the production code
- Don't hoist `ISO8601DateFormatter` to `nonisolated(unsafe)` globals for reuse across fetch functions — create local instances instead, since `NSFormatter` subclasses aren't thread-safe and the allocation cost is negligible
- SwiftUI `@State` in child views persists across parent data changes — use `.id(keyValue)` to force view recreation when context changes (e.g., project selection)
- Empty-state predicates must use the same filtered subset shown in UI sections; using raw collection counts can reintroduce stale-data visibility bugs.
- Reusing formatters at function scope is a good middle ground for Foundation formatter performance and thread safety: avoid both global shared formatters and per-row allocations.
- Even tiny `Date()` skew between parent and child views can create theoretical boundary inconsistencies; pass a shared reference time when multiple UI decisions depend on the same time window.
- When a parent view already captures reference time for filtering, child sections that derive display state should consume that same value to avoid consistency gaps and review churn.

### Risks / Blockers
- None
