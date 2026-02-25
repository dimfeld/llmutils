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
status: pending
priority: medium
dependencies:
  - 215
references:
  "215": 79f51dfc-c14b-4bd1-b129-324090af5a89
planGeneratedAt: 2026-02-25T08:32:23.173Z
promptsGeneratedAt: 2026-02-25T08:32:23.173Z
createdAt: 2026-02-25T08:31:27.699Z
updatedAt: 2026-02-25T08:32:23.174Z
tasks:
  - title: Add Plans tab to top-level navigation
    done: false
    description: 'In ContentView.swift, add a third segment "Plans" to the
      ViewSelection enum and segmented picker. This tab will show a
      full-featured plan browser. The navigation order should be: Sessions |
      Active | Plans.'
  - title: Create PlansView as the top-level container for the Plans tab
    done: false
    description: Create a new PlansView.swift that serves as the root view for the
      Plans tab. It should reuse the same project sidebar (ProjectListView) on
      the left, and show a dedicated plan browsing interface on the right when a
      project is selected. Share the ProjectTrackingStore instance so project
      selection is synchronized across tabs.
  - title: Move FilterChipsView and full plan list into PlansView
    done: false
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
tags:
  - tim-gui
---
