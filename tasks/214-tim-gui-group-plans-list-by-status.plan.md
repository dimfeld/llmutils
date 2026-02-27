---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: group plans list by status"
goal: ""
id: 214
uuid: f5b93792-9874-40c5-935a-f65a986da89d
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-02-27T09:09:45.383Z
promptsGeneratedAt: 2026-02-27T09:09:45.383Z
createdAt: 2026-02-25T08:21:01.172Z
updatedAt: 2026-02-27T10:16:02.629Z
tasks:
  - title: Extract status color/icon to PlanDisplayStatus computed properties
    done: true
    description: "In ProjectTrackingModels.swift, add import SwiftUI and add var
      color: Color and var icon: String computed properties to
      PlanDisplayStatus. Use the existing mappings (pending=.secondary/circle,
      inProgress=.blue/play.circle.fill,
      blocked=.orange/exclamationmark.circle.fill,
      recentlyDone=.green/checkmark.circle.fill, done=.gray/checkmark.circle,
      cancelled=.red/xmark.circle, deferred=.purple/clock.arrow.circlepath).
      Then update PlanRowView in ProjectsView.swift and PlanDetailView in
      PlansView.swift to use these new computed properties instead of their
      private switch statements."
  - title: Define PlanStatusGroup struct and groupPlansByStatus() function
    done: true
    description: "In PlansView.swift, add a PlanStatusGroup struct (status:
      PlanDisplayStatus, plans: [TrackedPlan], id = status) and a module-level
      constant for group ordering: [.inProgress, .pending, .blocked,
      .recentlyDone, .done, .deferred, .cancelled]. Add a pure function
      groupPlansByStatus(_ plans: [TrackedPlan], dependencyStatus: [String:
      Bool], now: Date) -> [PlanStatusGroup] that computes display status for
      each plan, groups them by status, orders groups by the predefined order,
      and filters out empty groups. Preserve within-group ordering from the
      input array."
  - title: Create PlanGroupHeaderView
    done: true
    description: "In PlansView.swift, create a PlanGroupHeaderView modeled on
      SessionGroupHeaderView from SessionsView.swift. It should show: animated
      chevron (rotationEffect 0 degrees collapsed, 90 degrees expanded with
      .easeInOut(duration: 0.2)), status icon (from PlanDisplayStatus.icon) in
      status color (from PlanDisplayStatus.color), status label text (from
      PlanDisplayStatus.label) in .subheadline.weight(.semibold), and plan count
      badge in a Capsule background. The whole header is tappable via
      .contentShape(Rectangle()).onTapGesture."
  - title: Modify PlansBrowserView for grouped rendering
    done: true
    description: "In PlansBrowserView in PlansView.swift: (1) Add @State private var
      collapsedGroups: Set<PlanDisplayStatus> = []. (2) After the existing
      filter+search+sort pipeline, call groupPlansByStatus() to produce groups.
      (3) Replace the flat LazyVStack ForEach(sorted) with grouped sections
      using ForEach(groups) containing Section with PlanGroupHeaderView header
      and conditional PlanRowView rendering based on collapse state. (4) Update
      the empty-state check to use groups.isEmpty. (5) Adapt the onChange
      deselection logic to use groups.flatMap to collect all visible UUIDs."
  - title: Remove Status sort option from PlanSortOrder
    done: true
    description: "In PlansView.swift: remove the .status case from PlanSortOrder
      enum, remove the statusRank() helper function, and remove the .status case
      from the sorted() method. Change the default sort in PlansBrowserView from
      .planNumber to .recentlyUpdated."
  - title: Write tests for groupPlansByStatus and update existing tests
    done: true
    description: "In PlansViewTests.swift: (1) Add a new test suite for
      groupPlansByStatus() covering: correct group order, empty groups excluded,
      within-group order preserved, all 7 statuses group correctly, blocked
      status (pending + unresolved deps) groups under .blocked, recentlyDone vs
      done based on now, single-status input returns one group, empty input
      returns empty array. (2) Remove PlanSortOrderStatusTests suite. (3) Update
      the case count test from 4 to 3 cases. (4) Add tests for
      PlanDisplayStatus.color and .icon computed properties."
changedFiles:
  - tim-gui/TimGUI/PlansView.swift
  - tim-gui/TimGUI/ProjectTrackingModels.swift
  - tim-gui/TimGUI/ProjectsView.swift
  - tim-gui/TimGUITests/PlansViewTests.swift
  - tim-gui/TimGUITests/SessionStateTests.swift
tags: []
---

Group plans by status and make each group collapsible. Sort the statuses by what is most useful: in progress, pending,
blocked, done, deferred, cancelled

## Expected Behavior/Outcome

When viewing the Plans browser tab, plans are grouped into collapsible sections by their display status. Each section has a header showing the status name, a count of plans in that group, and a chevron toggle for collapse/expand. Groups are ordered by usefulness: In Progress, Pending, Blocked, Recently Done, Done, Deferred, Cancelled. Empty groups (after filtering) are hidden. The existing sort order picker still applies within each group. Filter chips and search continue to work as before—filtering happens before grouping. All groups default to expanded.

## Key Findings

### Product & User Story
As a tim-gui user browsing the Plans tab, I want plans grouped by status so I can quickly scan what's in progress, what's ready to work on, and what's completed, without needing to mentally parse a flat list. Collapsible groups let me focus on the statuses I care about.

### Design & UX Approach
- Follow the existing collapsible group pattern from `SessionsView.swift` (`@State Set<PlanDisplayStatus>` for collapse tracking, custom header with animated chevron, `Section` wrapper)
- Group headers show: status icon + colored status label + plan count badge + animated chevron
- Status color and icon extracted to computed properties on `PlanDisplayStatus` (DRYing up duplicated mappings in `PlanRowView` and `PlanDetailView`)
- Empty groups are hidden entirely (only groups with matching plans after filtering/searching are shown)
- All groups start expanded by default; collapse state persists within session (survives tab switches)
- All 7 display statuses are separate groups (Recently Done is NOT merged with Done)

### Technical Plan & Risks
- The main change is in `PlansBrowserView` in `PlansView.swift`—replacing the flat `LazyVStack` with grouped sections
- A new `PlanStatusGroup` struct to hold grouped data (status, plans array)
- A new grouping function that takes filtered+searched plans and returns ordered groups
- A new `PlanGroupHeaderView` component modeled on `SessionGroupHeaderView`
- Risk: Grouping is computed from display status which depends on `now: Date`—must pass consistent `now` through the view hierarchy (already done)
- Risk: The `onChange(of: sorted.map(\.uuid))` deselection logic needs to be adapted to work with grouped data

### Pragmatic Effort Estimate
Small feature. 3 files to modify (`PlansView.swift`, `ProjectTrackingModels.swift`, `ProjectsView.swift`), 1 test file to update (`PlansViewTests.swift`). Follows well-established patterns already in the codebase.

## Acceptance Criteria

- [ ] Plans in the Plans browser tab are grouped by display status into collapsible sections
- [ ] Groups are ordered: In Progress, Pending, Blocked, Recently Done, Done, Deferred, Cancelled
- [ ] Each group header shows the status label and a count of plans in the group
- [ ] Clicking a group header toggles collapse/expand with animated chevron
- [ ] Empty groups (no plans after filtering/searching) are not shown
- [ ] All groups default to expanded state
- [ ] Existing filter chips and search continue to work correctly
- [ ] Sort order applies within each group (not across groups)
- [ ] The 'Status' sort option is removed from the sort picker (redundant with grouping); default sort is 'Recently Updated'
- [ ] Status color/icon computed properties are extracted to `PlanDisplayStatus` and used by `PlanRowView`, `PlanDetailView`, and group headers
- [ ] Selecting a plan still works and deselection when the plan is filtered out still works
- [ ] All new code paths are covered by tests

## Dependencies & Constraints

- **Dependencies**: Relies on existing `PlanDisplayStatus` enum, `planDisplayStatus()` function, `FilterChipsView`, `PlanSortOrder`, and `PlanRowView`.
- **Technical Constraints**: Must use `@State Set<PlanDisplayStatus>` for collapse state (not `DisclosureGroup`) per AGENTS.md conventions. Must pass consistent `now: Date` for time-dependent status calculations.

## Implementation Notes

### Recommended Approach
Modify `PlansBrowserView` to group the already-filtered-and-searched plans by display status, then render each group as a collapsible section. Reuse the chevron + header pattern from `SessionGroupHeaderView`. Keep grouping as a pure function for testability.

### Potential Gotchas
- `PlanDisplayStatus.allCases` follows declaration order (pending, inProgress, blocked, recentlyDone, done, cancelled, deferred) which differs from the desired display order. The grouping function must define its own explicit order.
- Recently Done and Done are separate groups (7 groups total).
- Collapse state should be keyed by `PlanDisplayStatus` (which is `Hashable`), not `String`.
- The `onChange(of: sorted.map(\.uuid))` deselection logic must be adapted to work with grouped output (flatMap the groups to get all visible UUIDs).
- The 'Status' sort option should be removed from `PlanSortOrder` since grouping makes it redundant. Default sort changes to `.recentlyUpdated`.

## Research

### Current Plans Browser Architecture

The Plans tab uses a 3-column `NavigationSplitView`:
1. **Column 1**: `ProjectListView` (project sidebar)
2. **Column 2**: `PlansBrowserView` (plan list with filters/search/sort)
3. **Column 3**: `PlanDetailView` (selected plan details)

The core rendering pipeline in `PlansBrowserView` (`PlansView.swift:191-287`) is:
```
store.filteredPlans(now:)  →  filterPlansBySearchText()  →  sortOrder.sorted()  →  LazyVStack { ForEach }
```

This flat pipeline needs to be extended with a grouping step after sorting:
```
store.filteredPlans(now:)  →  filterPlansBySearchText()  →  sortOrder.sorted()  →  groupByStatus()  →  Sections { ForEach }
```

### Key Files

| File | Role |
|------|------|
| `tim-gui/TimGUI/PlansView.swift` | Main file to modify. Contains `PlansBrowserView`, `PlanSortOrder`, `FilterChipsView`, `PlanDetailView` |
| `tim-gui/TimGUI/ProjectTrackingModels.swift` | `PlanDisplayStatus` enum (7 cases), `planDisplayStatus()` function, filter helpers |
| `tim-gui/TimGUI/ProjectTrackingStore.swift` | `ProjectTrackingStore` with `filteredPlans()`, `displayStatus(for:now:)`, `planDependencyStatus` |
| `tim-gui/TimGUI/ProjectsView.swift` | `PlanRowView` shared component (used in both Active Work and Plans tabs) |
| `tim-gui/TimGUI/SessionsView.swift` | Reference pattern for collapsible groups (`SessionGroupHeaderView`, `@State collapsedGroups`) |
| `tim-gui/TimGUITests/PlansViewTests.swift` | Existing test suite for `PlanSortOrder`, `filterPlansBySearchText`, date formatter |

### Existing Collapsible Group Pattern (SessionsView.swift)

The sessions tab implements collapsible groups with this pattern:

**State**: `@State private var collapsedGroups: Set<String> = []`

**Rendering**:
```swift
List(selection: ...) {
    ForEach(groupedSessions) { group in
        let isCollapsed = collapsedGroups.contains(group.id)
        Section {
            if !isCollapsed {
                ForEach(group.sessions) { session in ... }
            }
        } header: {
            SessionGroupHeaderView(group: group, isCollapsed: isCollapsed) {
                // toggle collapse
            }
        }
    }
}
```

**Header**: Animated chevron (`.rotationEffect(.degrees(isCollapsed ? 0 : 90))`), display name, count badge, optional notification dot (opacity-controlled).

The plans grouping will follow this same pattern but adapted for `ScrollView` + `LazyVStack` instead of `List` (since the plans browser doesn't use `List`).

### PlanDisplayStatus Enum (7 cases)

```swift
enum PlanDisplayStatus: String, CaseIterable, Hashable, Sendable {
    case pending, inProgress, blocked, recentlyDone, done, cancelled, deferred
}
```

Display status is derived from raw DB status + dependency info + time:
- `"pending"` → `.pending` (or `.blocked` if unresolved dependencies)
- `"in_progress"` → `.inProgress`
- `"done"` + updated < 7 days → `.recentlyDone`
- `"done"` + updated ≥ 7 days → `.done`
- `"cancelled"` → `.cancelled`
- `"deferred"` → `.deferred`

### Existing Status Sort Order (to be removed)

`PlanSortOrder.statusRank()` currently defines a rank: inProgress=0, blocked=1, pending=2, recentlyDone=3, deferred=4, done=5, cancelled=6. This sort option will be removed since grouping by status makes it redundant. The group order is: In Progress, Pending, Blocked, Recently Done, Done, Deferred, Cancelled.

### Status Colors and Icons (already defined)

Both `PlanRowView` and `PlanDetailView` define consistent status → color and status → icon mappings:
- pending: `.secondary`, `"circle"`
- inProgress: `.blue`, `"play.circle.fill"`
- blocked: `.orange`, `"exclamationmark.circle.fill"`
- recentlyDone: `.green`, `"checkmark.circle.fill"`
- done: `.gray`, `"checkmark.circle"`
- cancelled: `.red`, `"xmark.circle"`
- deferred: `.purple`, `"clock.arrow.circlepath"`

These should be extracted or referenced for use in the group header, or the header can simply use the status label and a colored accent.

### Test Patterns

Tests use Swift Testing framework (`@Suite`, `@Test` macros). The `makePlan()` helper creates `TrackedPlan` instances with configurable fields. Tests for grouping should follow the same patterns:
- Test group ordering
- Test empty groups are excluded
- Test grouping with mixed statuses
- Test that within-group sort order is preserved
- Test with dependency-based blocked status

## Implementation Guide

### Step 1: Define Group Order and Data Structure

In `PlansView.swift`, add a `PlanStatusGroup` struct and a group ordering array.

```swift
struct PlanStatusGroup: Identifiable {
    let status: PlanDisplayStatus
    let plans: [TrackedPlan]
    var id: PlanDisplayStatus { status }
}
```

Define the desired group order as a static array. The order from the plan description is: In Progress, Pending, Blocked, Recently Done, Done, Deferred, Cancelled. This can be a module-level constant or a static property.

### Step 2: Create the Grouping Function

Add a pure function `groupPlansByStatus()` that takes:
- `plans: [TrackedPlan]` (already filtered, searched, and sorted)
- `dependencyStatus: [String: Bool]`
- `now: Date`

And returns `[PlanStatusGroup]` — an ordered array of non-empty groups.

The function should:
1. Compute the display status for each plan
2. Group plans into a dictionary keyed by `PlanDisplayStatus`
3. Map the predefined group order into `PlanStatusGroup` instances
4. Filter out groups with no plans (empty groups)
5. Preserve the within-group order from the input (already sorted by `PlanSortOrder`)

This function is pure and easily testable.

### Step 3: Create PlanGroupHeaderView

Model this on `SessionGroupHeaderView` from `SessionsView.swift`. The header should show:
- Animated chevron (rotates 0° when collapsed, 90° when expanded)
- Status label text (from `PlanDisplayStatus.label`)
- Plan count badge (capsule background like session group count)
- The whole header is tappable via `.contentShape(Rectangle()).onTapGesture`

Use the existing status color for the label text to provide visual distinction between groups. The chevron can be `.secondary` like the session groups.

### Step 4: Modify PlansBrowserView to Use Grouped Rendering

Replace the current flat `LazyVStack { ForEach(sorted) }` in `PlansBrowserView` with:

1. Add `@State private var collapsedGroups: Set<PlanDisplayStatus> = []` to `PlansBrowserView`
2. After sorting, call `groupPlansByStatus()` to produce the groups
3. Replace the `LazyVStack { ForEach(sorted) }` with:
   ```swift
   LazyVStack(spacing: 6) {
       ForEach(groups) { group in
           let isCollapsed = collapsedGroups.contains(group.status)
           Section {
               if !isCollapsed {
                   ForEach(group.plans) { plan in
                       PlanRowView(...)
                   }
               }
           } header: {
               PlanGroupHeaderView(...)
           }
       }
   }
   ```

4. Adapt the `onChange(of: sorted.map(\.uuid))` deselection logic. Instead of using `sorted`, flatMap the groups to collect all visible UUIDs:
   ```swift
   let allVisibleUuids = groups.flatMap { $0.plans.map(\.uuid) }
   ```

5. The empty-state check should use `groups.isEmpty` instead of `sorted.isEmpty`.

### Step 5: Extract Status Color/Icon to PlanDisplayStatus

Add `var color: Color` and `var icon: String` computed properties to `PlanDisplayStatus` in `ProjectTrackingModels.swift`. Use the same mappings already defined in `PlanRowView` and `PlanDetailView`:
- pending: `.secondary`, `"circle"`
- inProgress: `.blue`, `"play.circle.fill"`
- blocked: `.orange`, `"exclamationmark.circle.fill"`
- recentlyDone: `.green`, `"checkmark.circle.fill"`
- done: `.gray`, `"checkmark.circle"`
- cancelled: `.red`, `"xmark.circle"`
- deferred: `.purple`, `"clock.arrow.circlepath"`

Then update `PlanRowView` (in `ProjectsView.swift`) and `PlanDetailView` (in `PlansView.swift`) to use these new computed properties instead of their private switch statements. The new `PlanGroupHeaderView` will also use these properties.

Note: `ProjectTrackingModels.swift` needs `import SwiftUI` (it currently only imports `Foundation`) to use `Color`.

### Step 6: Remove Status Sort Option

Remove the `.status` case from `PlanSortOrder` in `PlansView.swift`. It's redundant now that plans are grouped by status. Also:
- Remove the `statusRank()` helper function
- Change the default sort from `.planNumber` to `.recentlyUpdated`: `@State private var sortOrder: PlanSortOrder = .recentlyUpdated`
- Update the `PlanSortOrder` tests in `PlansViewTests.swift` to remove the status sort suite and update the "has exactly 4 cases" test to "has exactly 3 cases"

### Step 7: Write Tests

In `PlansViewTests.swift`:

1. **Test `groupPlansByStatus()`**:
   - Groups are in the correct order (inProgress, pending, blocked, recentlyDone, done, deferred, cancelled)
   - Empty groups are excluded
   - Plans within each group maintain input order (sort order preserved)
   - All 7 statuses group correctly when plans span all statuses
   - Blocked status (pending + unresolved deps) groups under `.blocked`
   - Recently done vs. done groups correctly based on `now`
   - Single-status input returns one group
   - Empty input returns empty array

2. **Update existing tests**:
   - Remove `PlanSortOrderStatusTests` suite
   - Update "PlanSortOrder has exactly 4 cases" to "has exactly 3 cases"
   - Verify `PlanDisplayStatus.color` and `.icon` computed properties return expected values

### Step 8: Reset Collapse State on Project Change

The `PlansBrowserView` already has `.id(self.store.selectedProjectId)` which resets `@State` when the project changes. Since `collapsedGroups` is `@State`, it will automatically reset to `[]` (all expanded) when the project changes. No additional work needed.

### Manual Testing Steps

1. Open the Plans tab, select a project with plans in multiple statuses
2. Verify groups appear in the correct order with headers
3. Click a group header — verify it collapses/expands with animated chevron
4. Verify plan counts in headers match the number of visible plans
5. Toggle filter chips — verify groups update dynamically, empty groups disappear
6. Search for a term — verify grouping updates, groups with no matches disappear
7. Change sort order — verify plans re-sort within their groups
8. Select a plan, then filter it out — verify selection clears
9. Switch projects — verify all groups reset to expanded

## Current Progress
### Current State
- All 6 tasks completed, tested, and reviewed. Full feature implemented.
### Completed (So Far)
- Task 1: Extracted `color` and `icon` computed properties to `PlanDisplayStatus` in `ProjectTrackingModels.swift`. Updated `PlanRowView`, `PlanDetailView`, and `FilterChipsView` to use them.
- Task 2: Added `PlanStatusGroup` struct, `planStatusGroupOrder` constant, and `groupPlansByStatus()` pure function in `PlansView.swift`.
- Task 3: Created `PlanGroupHeaderView` with animated chevron, status icon/color, label, and count badge.
- Task 4: Modified `PlansBrowserView` for grouped rendering with `collapsedGroups` state, Section-based layout, and adapted deselection logic.
- Task 5: Removed `.status` from `PlanSortOrder`, default sort changed to `.recentlyUpdated`.
- Task 6: Comprehensive tests for `groupPlansByStatus()` (14 cases), `PlanDisplayStatus` properties, `visiblePlanUuids()`, and default sort order.
### Remaining
- None. All tasks complete.
### Next Iteration Guidance
- Manual testing recommended per the plan's manual testing steps.
### Decisions / Changes
- `FilterChipsView` also updated to use `PlanDisplayStatus.color` (was not explicitly in the plan but removes duplication).
- `group.status` used directly for PlanRowView displayStatus in grouped rendering (avoids redundant recomputation).
- `planBrowserDefaultSortOrder` extracted as module-level constant for testability.
- `visiblePlanUuids(from:)` extracted as pure function for testability.
- Collapse toggle wrapped in `withAnimation(.easeInOut(duration: 0.2))` for smooth content transitions in LazyVStack.
### Lessons Learned
- In ScrollView + LazyVStack (unlike List), content changes from state mutations don't animate implicitly. Must wrap state mutations in `withAnimation` for smooth transitions.
- When grouping plans by status, pass `group.status` directly to child views rather than recomputing via `store.displayStatus()` — it's redundant by construction and avoids inconsistency.
### Risks / Blockers
- None
