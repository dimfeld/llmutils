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
status: done
priority: medium
dependencies:
  - 215
references:
  "215": 79f51dfc-c14b-4bd1-b129-324090af5a89
planGeneratedAt: 2026-02-25T08:32:23.173Z
promptsGeneratedAt: 2026-02-25T08:32:23.173Z
createdAt: 2026-02-25T08:31:27.699Z
updatedAt: 2026-02-26T21:24:02.391Z
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
    done: true
    description: Add a search text field at the top of the plans list that filters
      plans by title and goal text. This makes it easy to find specific plans in
      projects with many plans. Use a simple local text filter on the
      already-fetched plan data.
  - title: Add sorting options for the plans list
    done: true
    description: "Add a sort control (e.g. a picker or menu) allowing the user to
      sort plans by: plan number (default), priority, recently updated, or
      status. The current default sort should be preserved but users should be
      able to reorder for different workflows like triage."
  - title: Show expanded plan detail on selection
    done: true
    description: "When a plan row is clicked/selected in the plans browser, show an
      expanded detail panel (either inline expansion, a sheet, or a third
      column) with the full plan information: title, goal, status, priority,
      dependencies, assigned workspace, and timestamps. This gives more context
      than the compact row view."
changedFiles:
  - README.md
  - tim-gui/AGENTS.md
  - tim-gui/TimGUI/ContentView.swift
  - tim-gui/TimGUI/PlansView.swift
  - tim-gui/TimGUI/ProjectTrackingModels.swift
  - tim-gui/TimGUI/ProjectTrackingStore.swift
  - tim-gui/TimGUI/ProjectsView.swift
  - tim-gui/TimGUI.xcodeproj/project.pbxproj
  - tim-gui/TimGUITests/PlansViewTests.swift
  - tim-gui/TimGUITests/ProjectTrackingModelTests.swift
  - tim-gui/TimGUITests/ProjectTrackingStoreTests.swift
tags:
  - tim-gui
---

## Current Progress
### Current State
- All 6 tasks are complete. The Plans tab is fully implemented with navigation, project sidebar, filter chips, search, sorting, plan list with selection, and expanded plan detail panel.
### Completed (So Far)
- Task 1: Added `.plans` case to `AppTab` enum in ContentView.swift, navigation order is Sessions | Active Work | Plans
- Task 2: Created PlansView.swift with `NavigationSplitView`, reusing `ProjectListView` sidebar and shared `ProjectTrackingStore`
- Task 3: Built `FilterChipsView` with all 7 `PlanDisplayStatus` filter chips, Reset/All controls, and scrollable filtered plan list using existing `PlanRowView`
- Task 4: Added search text field with magnifying glass icon that filters plans by title and goal text using `localizedCaseInsensitiveContains`. Search resets on project change via `.id(store.selectedProjectId)`.
- Task 5: Added `PlanSortOrder` enum with four sort modes: Plan Number (default, descending), Priority, Recently Updated, Status. Compact `.menu`-style Picker control. All sort modes have deterministic tiebreakers (planId DESC, then uuid).
- Task 6: Converted PlansSplitView to 3-column NavigationSplitView (sidebar | plan list | detail). PlanDetailView shows plan number, title, full goal, status with icon, priority, unresolved dependencies, assigned workspace (or "Unassigned"), branch, epic indicator, parent UUID, filename, and timestamps. Selection clears on project change and when selected plan is filtered out. `.id(uuid)` on detail view ensures scroll position resets.
- Fixed refresh lifecycle race condition: `startRefreshing()`/`stopRefreshing()` are now reference-counted so multiple tabs sharing the store don't cancel each other's refresh loops
- Made shared views (`ProjectListView`, `ProjectRowView`, `PlanRowView`, etc.) non-private in ProjectsView.swift for reuse
- Extracted `filterPlansBySearchText()` as module-level function for testability
- New `PlansViewTests.swift` with comprehensive test coverage for sorting, search filtering, and date formatting
### Remaining
- None
### Next Iteration Guidance
- None — all tasks complete
### Decisions / Changes
- `PlansView.swift` follows the same architectural pattern as `ProjectsView.swift` (split view, load state handling, store binding)
- Filter chips use colored fill backgrounds when active, subtle gray when inactive
- Reference-counted refresh lifecycle in `ProjectTrackingStore` prevents race conditions across tabs
- Priority sort includes `maybe` rank (urgent > high > medium > low > maybe > nil/unknown) to match tim's full priority semantics
- `.planNumber` sort matches DB order: `plan_id DESC, updated_at DESC, uuid ASC`
- All sort modes use planId as secondary tiebreaker for deterministic ordering across refresh cycles
- Plan detail uses 3-column NavigationSplitView rather than sheet or inline expansion for macOS-native feel
- PlanRowView gained `isSelected` parameter (default false) with accent color highlight matching ProjectRowView's pattern
- Dependencies row only shows when there are unresolved dependencies (hidden otherwise, since data model only tracks boolean unresolved state)
- Workspace row always visible, showing "Unassigned" when no workspace is assigned
### Lessons Learned
- When multiple SwiftUI views share an @Observable store and both manage lifecycle (onAppear/onDisappear), lifecycle ordering is not guaranteed during tab switches. Reference-counting start/stop calls prevents race conditions.
- Tests should verify observable behavior (loadState, data freshness) rather than inspecting private implementation details like task handles.
- Sort comparators need deterministic tiebreakers to prevent list jitter on periodic UI refreshes. Even with Swift's stable sort, the source array order can change between DB refresh cycles.
- When implementing domain-specific sort rankings (like priority), check the full set of valid values in the upstream system (tim supports `maybe` priority which is easy to miss).
- When adding detail views in SwiftUI NavigationSplitView, always add `.id(selectedId)` to the detail view to force scroll position reset when selection changes — otherwise SwiftUI reuses the same ScrollView and may preserve the old scroll offset.
- When a data model only exposes partial info (e.g., boolean "has unresolved deps" but not a list), it's better to hide the row when there's no actionable info rather than show an ambiguous "None" label.
### Risks / Blockers
- None
