---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: option+up/down should go to next/previous session or plan
goal: ""
id: 257
uuid: e1cc32f1-a4fe-4d02-9709-5fc62ee25d9c
generatedBy: agent
status: pending
priority: medium
planGeneratedAt: 2026-03-22T09:38:17.448Z
promptsGeneratedAt: 2026-03-22T09:38:17.448Z
createdAt: 2026-03-22T08:35:33.330Z
updatedAt: 2026-03-22T09:38:17.449Z
tasks:
  - title: Create shared keyboard navigation helper
    done: false
    description: 'Create src/lib/utils/keyboard_nav.ts with three functions:
      isListNavEvent(event) to detect Alt+ArrowUp/Down, getAdjacentItem(items,
      currentId, direction) for adjacent index computation with no-wrap boundary
      behavior, and scrollListItemIntoView(itemId) that queries for
      [data-list-item-id] and calls scrollIntoView({ block: "nearest" }).'
  - title: Add data-list-item-id attributes to row components
    done: false
    description: Add data-list-item-id={connectionId} to SessionRow.svelte root
      element, data-list-item-id={plan.uuid} to PlanRow.svelte root element, and
      data-list-item-id={plan.uuid} to ActivePlanRow.svelte root element. These
      are used by scrollListItemIntoView to find target elements.
  - title: Add keyboard navigation to SessionList
    done: false
    description: "In SessionList.svelte: add svelte:window onkeydown handler, add
      $derived computing flat list of visible session connection IDs (iterating
      groups, skipping collapsed), use isListNavEvent + getAdjacentItem +
      goto(sessionHref(nextId)) + tick + scrollListItemIntoView pattern. Import
      goto from $app/navigation and tick from svelte."
  - title: Add keyboard navigation to PlansList
    done: false
    description: "In PlansList.svelte: add svelte:window onkeydown handler, add
      $derived computing flat list of visible plan UUIDs (iterating statusOrder,
      skipping collapsedGroups, collecting from groupedPlans), use same
      navigation pattern. Navigate to /projects/${projectId}/plans/${nextId}.
      Import goto and tick."
  - title: Add keyboard navigation to Active Work layout
    done: false
    description: "In src/routes/projects/[projectId]/active/+layout.svelte: add
      svelte:window onkeydown handler, flat list is data.activePlans.map(p =>
      p.uuid), navigate to /projects/${projectId}/active/${nextId}. Use same
      pattern with goto + tick + scrollListItemIntoView."
  - title: Write tests for keyboard_nav utilities
    done: false
    description: "Create src/lib/utils/keyboard_nav.test.ts testing: getAdjacentItem
      (next/prev, boundary no-wrap, empty list, null currentId, currentId not in
      list) and isListNavEvent (Alt+ArrowUp/Down detection, rejection of other
      combos like plain arrows, Ctrl+arrows, etc)."
  - title: Format and type-check
    done: false
    description: Run bun run format and bun run check to ensure code quality and no
      type errors.
tags: []
---

When on sessions, active work, or plans, option+up/down should go to the next/previous session or plan in the list. This
should work regardless of what is focused.

## Research

### Problem Overview

The web interface has three main tabs—Sessions, Active Work, and Plans—each with a split-pane layout: a list of items on the left and a detail view on the right. Currently, the only way to navigate between items is by clicking. There is no keyboard shortcut to quickly move to the next or previous item in the list. This feature adds Option+ArrowUp / Option+ArrowDown (Alt+ArrowUp / Alt+ArrowDown on non-macOS) as a global shortcut to navigate between items regardless of what element currently has focus.

### Key Findings

#### Current Selection Mechanism

All three tabs use **URL-based selection**. The currently selected item is determined by a route param:

- **Sessions**: `/projects/[projectId]/sessions/[connectionId]` — `page.params.connectionId`
- **Plans**: `/projects/[projectId]/plans/[planId]` — `page.params.planId`
- **Active Work**: `/projects/[projectId]/active/[planId]` — `page.params.planId`

Clicking a list item navigates via `<a href>`, which updates the URL and triggers reactivity. There is no separate store-based selection state; the URL is the single source of truth.

Navigation is done programmatically via `goto()` from `$app/navigation`.

#### List Structures and Item Ordering

Each tab renders its list differently, with groups and filtering:

**Sessions** (`src/lib/components/SessionList.svelte`):
- Items come from `sessionManager.sessionGroups` (a `$derived` on the SessionManager).
- Groups are identified by `group.groupKey` and can be collapsed via a `SvelteSet<string>`.
- Within each group, sessions are ordered as provided by the store (sorted with current project first).
- The flat ordered list of visible sessions = iterate groups in order, skip collapsed groups, collect `session.connectionId` values.
- The `sessionHref` callback constructs the URL: `/projects/${projectId}/sessions/${encodeURIComponent(connectionId)}`.

**Plans** (`src/lib/components/PlansList.svelte`):
- Items come from server-loaded `data.plans`, then filtered by search query and active status filters, sorted by the selected sort option, and grouped by `displayStatus`.
- Groups follow a fixed status order and can be collapsed via `collapsedGroups` state.
- The flat ordered list of visible plans = iterate `statusOrder`, skip collapsed or empty groups, collect `plan.uuid` values.
- Href pattern: `/projects/${projectId}/plans/${plan.uuid}`.

**Active Work** (`src/routes/projects/[projectId]/active/+layout.svelte`):
- The left pane has two sections: Workspaces (not navigable as plan items) and Active Plans.
- Active plans are rendered as `ActivePlanRow` components in a flat list from `data.activePlans`.
- No grouping or collapsing for active plans.
- Href pattern: `/projects/${projectId}/active/${plan.uuid}`.

#### Existing Keyboard Handling Patterns

There are very few keyboard handlers in the codebase:

1. **Sidebar toggle** (`src/lib/components/ui/sidebar/sidebar-provider.svelte`): Uses `<svelte:window onkeydown={handler}>` to listen for Ctrl/Cmd+B globally. The handler is defined in `src/lib/components/ui/sidebar/context.svelte.ts`.

2. **MessageInput** and **PromptRenderer**: Local `onkeydown` handlers on input elements (Enter to submit).

The sidebar shortcut pattern is the most relevant precedent—it demonstrates how to add a global keyboard shortcut via `svelte:window`.

#### Tab Detection

The current tab can be determined from `page.url.pathname`. The project layout at `src/routes/projects/[projectId]/+layout.svelte` already derives the tab from the URL path. The path structure is `/projects/{projectId}/{tab}/...` where tab is `sessions`, `active`, or `plans`.

### Architecture Considerations

**Challenge: Accessing the ordered item list from the global handler.**

The list of visible items (accounting for search filters, collapsed groups, sort order) is computed inside each list component (SessionList, PlansList, active layout). A global keyboard handler needs access to this ordered list to determine what "next" and "previous" mean.

**Recommended approach**: Each list component (SessionList, PlansList, active layout) adds its own `<svelte:window onkeydown={handler}>`. Since only one tab is mounted at a time, there's no conflict between handlers. Each component already has access to the visible item ordering, current selection, and href generation—no need for a shared registration pattern.

A small shared utility function handles the common logic: given an ordered list of IDs, the current ID, and a direction, compute the next ID. This is extracted into `src/lib/utils/keyboard_nav.ts` for reuse and testability.

**Alternative considered**: A context-based registration pattern where tab layouts register navigation providers and a single global handler consumes them. This is over-engineered for this use case since only one tab is ever active.

**Alternative considered**: Using DOM queries to find all `<a>` elements in the list pane. This is fragile and doesn't cleanly handle collapsed groups or the concept of "currently selected."

### Dependencies & Constraints

- **Dependencies**: SvelteKit's `goto()` for programmatic navigation, `$app/state` for reading current route params.
- **Technical Constraints**: The shortcut should always fire, even when focus is in text inputs. Alt+Down/Up has no standard text editing meaning, so there's no conflict.
- **Browser Compatibility**: `Alt+ArrowUp/Down` is the equivalent on non-macOS platforms. The `event.altKey` property works cross-platform.

### Expected Behavior/Outcome

- Pressing Option+Down (Alt+Down) navigates to the next item in the current tab's list.
- Pressing Option+Up (Alt+Up) navigates to the previous item in the current tab's list.
- If no item is currently selected, Option+Down selects the first visible item; Option+Up selects the last visible item.
- Navigation wraps: at the last item, Option+Down does nothing (or optionally wraps to first); at the first item, Option+Up does nothing (or optionally wraps to last). Non-wrapping is recommended to avoid disorientation.
- Collapsed groups are skipped—only visible items are navigable.
- Filtered-out plans are skipped.
- Works regardless of focus state, including when in text inputs.
- The navigated-to item is scrolled into view if it's outside the visible area of the list pane, using `scrollIntoView({ block: 'nearest' })` to minimize unnecessary scrolling.

### Acceptance Criteria

- [ ] Option+Down navigates to the next session/plan in the list on all three tabs.
- [ ] Option+Up navigates to the previous session/plan in the list on all three tabs.
- [ ] Navigation respects collapsed groups and active filters (skips hidden items).
- [ ] Keyboard shortcut fires regardless of focus state, including when in text inputs.
- [ ] When no item is selected, the shortcut selects the first (Down) or last (Up) visible item.
- [ ] At list boundaries, the shortcut does nothing (no wrap).
- [ ] The navigated-to item is scrolled into view if not already visible.
- [ ] All new code paths are covered by tests.

### Key Findings Summary

- **Product & User Story**: Power users navigating many sessions or plans need a fast keyboard shortcut to step through items without reaching for the mouse.
- **Design & UX Approach**: Option+Arrow is a standard macOS convention for "move by larger unit" (word in text, paragraph in editors). It maps well to "move to next list item." No visual indicator needed beyond the existing selection highlighting.
- **Technical Plan & Risks**: Main risk is getting the ordered list of visible items correct (respecting collapsed groups, filters). Each list component already computes this, so the handler lives in the component itself. No cross-component coordination needed.
- **Pragmatic Effort Estimate**: Small feature. One shared utility file, `svelte:window onkeydown` added to three list components.

## Implementation Guide

### Step 1: Create the shared navigation helper

Create `src/lib/utils/keyboard_nav.ts` with these functions:

**`isListNavEvent(event: KeyboardEvent): 'up' | 'down' | null`** — Returns `'up'` or `'down'` if `event.altKey` and key is ArrowUp/ArrowDown, otherwise `null`.

**`getAdjacentItem(items: string[], currentId: string | null, direction: 'up' | 'down'): string | null`** — Given an ordered list of item IDs, the currently selected ID, and a direction:
- If `items` is empty, return `null`.
- If `currentId` is null or not found in `items`: return first item (down) or last item (up).
- Otherwise, compute the adjacent index. If at boundary, return `null` (no wrap).

**`scrollListItemIntoView(itemId: string): void`** — Finds the DOM element with `[data-list-item-id="${itemId}"]` and calls `element.scrollIntoView({ block: 'nearest' })` on it. Uses `block: 'nearest'` to minimize scrolling—only scrolls if the element is out of the visible area. This should be called after `tick()` (from `svelte`) to ensure the DOM has updated after navigation.

**Rationale**: Extracting the pure logic makes it easy to unit test without DOM or Svelte. Each list component calls these helpers in its own `svelte:window onkeydown` handler.

### Step 2: Add `data-list-item-id` attributes to row components

Add `data-list-item-id={connectionId}` to the root element of `SessionRow.svelte`, `data-list-item-id={plan.uuid}` to `PlanRow.svelte`, and `data-list-item-id={plan.uuid}` to `ActivePlanRow.svelte`. This is used by the scroll-into-view helper to find the target element after keyboard navigation.

### Step 3: Add keyboard navigation to SessionList

In `src/lib/components/SessionList.svelte`:

- Add `<svelte:window onkeydown={handleKeydown} />`.
- Add a `$derived` that computes the flat list of visible session connection IDs: iterate `groups` in order, skip groups in the `collapsed` set, collect each `session.connectionId`.
- In `handleKeydown`, call `isListNavEvent(event)`. If non-null, call `getAdjacentItem(visibleIds, selectedSessionId, direction)`. If a result is returned, call `goto(sessionHref(nextId))`, then after `tick()` call `scrollListItemIntoView(nextId)`, and `event.preventDefault()`.
- Import `goto` from `$app/navigation` and `tick` from `svelte`.

### Step 4: Add keyboard navigation to PlansList

In `src/lib/components/PlansList.svelte`:

- Add `<svelte:window onkeydown={handleKeydown} />`.
- Add a `$derived` that computes the flat list of visible plan UUIDs: iterate `statusOrder`, skip statuses in `collapsedGroups`, collect `plan.uuid` from each non-empty group in `groupedPlans`.
- In `handleKeydown`, use the same pattern as SessionList. Navigate to `/projects/${projectId}/plans/${nextId}`. After `tick()`, call `scrollListItemIntoView(nextId)`.
- Import `goto` from `$app/navigation` and `tick` from `svelte`.

### Step 5: Add keyboard navigation to Active Work layout

In `src/routes/projects/[projectId]/active/+layout.svelte`:

- Add `<svelte:window onkeydown={handleKeydown} />`.
- The flat list is simply `data.activePlans.map(p => p.uuid)` — no grouping or collapsing.
- Navigate to `/projects/${projectId}/active/${nextId}`. After `tick()`, call `scrollListItemIntoView(nextId)`.
- Import `goto` from `$app/navigation` and `tick` from `svelte`.

### Step 6: Write tests

Create `src/lib/utils/keyboard_nav.test.ts` to test:
- `getAdjacentItem`: next/previous index computation, boundary behavior (no wrap), empty list, null currentId, currentId not in list.
- `isListNavEvent`: correct detection of Alt+ArrowUp/Down, rejection of other key combos.

### Step 7: Format and verify

Run `bun run format` and `bun run check` to ensure code quality.

### Manual Testing Steps

1. Open the Sessions tab, select a session, press Option+Down—should navigate to next session.
2. Press Option+Up—should go back.
3. Collapse a session group, verify navigation skips it.
4. Switch to Plans tab, verify same behavior with plan items.
5. Apply a search filter in Plans, verify navigation only visits filtered items.
6. Switch to Active Work tab, verify navigation works on active plans.
7. Focus the search input in Plans, press Option+Down—should still navigate to next plan.
8. With no item selected, press Option+Down—should select first item.
9. At last item, press Option+Down—should do nothing.
