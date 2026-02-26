---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: Add dedicated Plans browser tab"
goal: Add a new top-level 'Plans' tab to the navigation that provides a
  full-featured plan browsing experience with status filters, search, and
  detailed plan information — the comprehensive view that was previously part of
  the Projects tab
id: 216
uuid: 522e1e77-3702-4a3a-a74a-665cae4bea32
generatedBy: agent
status: in_progress
priority: medium
dependencies:
  - 215
references:
  "215": 79f51dfc-c14b-4bd1-b129-324090af5a89
planGeneratedAt: 2026-02-25T08:32:23.173Z
promptsGeneratedAt: 2026-02-25T08:32:23.173Z
createdAt: 2026-02-25T08:31:27.699Z
updatedAt: 2026-02-26T20:09:02.581Z
tasks:
  - title: Add Plans tab to top-level navigation
    done: true
    description: 'In ContentView.swift, add a third segment "Plans" to the
      ViewSelection enum and segmented picker. This tab will show a
      full-featured plan browser. The navigation order should be: Sessions |
      Active | Plans.'
  - title: Create PlansView as the top-level container for the Plans tab
    done: true
    description: Create a new PlansView.swift that serves as the root view for the
      Plans tab. It should reuse the same project sidebar (ProjectListView) on
      the left, and show a dedicated plan browsing interface on the right when a
      project is selected. Share the ProjectTrackingStore instance so project
      selection is synchronized across tabs.
  - title: Move FilterChipsView and full plan list into PlansView
    done: true
    description: "Move the FilterChipsView (with all status filter chips: Pending,
      In Progress, Blocked, Recently Done, Done, Cancelled, Deferred) and the
      full PlanRowView list from the old ProjectDetailView into the new
      PlansView detail pane. This becomes the comprehensive plan browsing
      experience with Reset/All controls."
  - title: Add search/filter input for plans
    done: false
    description: Add a search text field at the top of the plans list that filters
      plans by title and goal text. This makes it easy to find specific plans in
      projects with many plans. Use a simple local text filter on the
      already-fetched plan data.
  - title: Add sorting options for the plans list
    done: false
    description: "Add a sort control (e.g. a picker or menu) allowing the user to
      sort plans by: plan number (default), priority, recently updated, or
      status. The current default sort should be preserved but users should be
      able to reorder for different workflows like triage."
  - title: Show expanded plan detail on selection
    done: false
    description: "When a plan row is clicked/selected in the plans browser, show an
      expanded detail panel (either inline expansion, a sheet, or a third
      column) with the full plan information: title, goal, status, priority,
      dependencies, assigned workspace, and timestamps. This gives more context
      than the compact row view."
changedFiles:
  - tim-gui/TimGUI/ContentView.swift
  - tim-gui/TimGUI/PlansView.swift
  - tim-gui/TimGUI/ProjectTrackingStore.swift
  - tim-gui/TimGUI/ProjectsView.swift
  - tim-gui/TimGUI.xcodeproj/project.pbxproj
  - tim-gui/TimGUITests/ProjectTrackingModelTests.swift
  - tim-gui/TimGUITests/ProjectTrackingStoreTests.swift
tags:
  - tim-gui
---

## Current Progress
### Current State
- Tasks 1-3 are complete. The Plans tab is functional with navigation, project sidebar, filter chips, and filtered plan list.
### Completed (So Far)
- Task 1: Added `.plans` case to `AppTab` enum in ContentView.swift, navigation order is Sessions | Active Work | Plans
- Task 2: Created PlansView.swift with `NavigationSplitView`, reusing `ProjectListView` sidebar and shared `ProjectTrackingStore`
- Task 3: Built `FilterChipsView` with all 7 `PlanDisplayStatus` filter chips, Reset/All controls, and scrollable filtered plan list using existing `PlanRowView`
- Fixed refresh lifecycle race condition: `startRefreshing()`/`stopRefreshing()` are now reference-counted so multiple tabs sharing the store don't cancel each other's refresh loops
- Made shared views (`ProjectListView`, `ProjectRowView`, `PlanRowView`, etc.) non-private in ProjectsView.swift for reuse
- Updated stale comment on `activeFilters` property
### Remaining
- Task 4: Add search/filter text input for plans
- Task 5: Add sorting options (plan number, priority, recently updated, status)
- Task 6: Show expanded plan detail on selection
### Next Iteration Guidance
- Tasks 4 and 5 (search and sort) modify the same `PlansBrowserView` in PlansView.swift and should be done together
- Task 6 (detail panel) is independent and can be done separately or with 4-5
### Decisions / Changes
- `PlansView.swift` follows the same architectural pattern as `ProjectsView.swift` (split view, load state handling, store binding)
- Filter chips use colored fill backgrounds when active, subtle gray when inactive
- Reference-counted refresh lifecycle in `ProjectTrackingStore` prevents race conditions across tabs
### Lessons Learned
- When multiple SwiftUI views share an @Observable store and both manage lifecycle (onAppear/onDisappear), lifecycle ordering is not guaranteed during tab switches. Reference-counting start/stop calls prevents race conditions.
- Tests should verify observable behavior (loadState, data freshness) rather than inspecting private implementation details like task handles.
### Risks / Blockers
- None
