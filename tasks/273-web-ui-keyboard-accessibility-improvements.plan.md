---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "Web UI: Keyboard accessibility improvements"
goal: "Improve keyboard accessibility across the web UI: add proper ARIA labels
  to interactive elements, manage focus in confirmation dialogs and modals,
  ensure status indicators are not color-only, and add keyboard shortcuts for
  common actions."
id: 273
uuid: cb5d783a-daf4-4bf5-a489-6173dfb10f54
status: done
priority: medium
planGeneratedAt: 2026-03-26T10:28:44.212Z
createdAt: 2026-03-24T19:18:05.222Z
updatedAt: 2026-03-27T00:02:12.169Z
tasks:
  - title: Add aria-label and role to PrStatusIndicator
    done: true
    description: Add aria-label={title} and role="img" to the colored dot span in
      PrStatusIndicator.svelte so screen readers announce the PR check status.
  - title: Add aria-pressed to FilterChips toggle buttons
    done: true
    description: Add aria-pressed={isActive} to each filter button in
      FilterChips.svelte to communicate toggle state to screen readers.
  - title: Add aria-expanded and aria-label to SessionList collapse buttons
    done: true
    description: Add aria-expanded={!isCollapsed} and aria-label="Toggle
      {group.label} group" to group toggle buttons in SessionList.svelte. Mark
      triangle spans with aria-hidden="true".
  - title: Add aria-expanded and aria-label to PlansList collapse buttons
    done: true
    description: 'Same pattern as SessionList: add aria-expanded and aria-label on
      group buttons in PlansList.svelte. Also add aria-label="Search plans" to
      the search input.'
  - title: Add aria-current and aria-label to TabNav
    done: true
    description: 'Add aria-current={active ? "page" : undefined} to each tab link
      and aria-label="Main navigation" to the nav element in TabNav.svelte.'
  - title: Add aria-label and aria-current to ProjectSidebar
    done: true
    description: 'Add aria-label="Project navigation" to the nav element and
      aria-current={isSelected ? "page" : undefined} to project links in
      ProjectSidebar.svelte.'
  - title: Add accessible status dot to SessionDetail header
    done: true
    description: Add aria-label={statusText} and role="img" to the status dot span
      in SessionDetail.svelte header so the session status is conveyed to screen
      readers.
  - title: Add aria-label to MessageInput textarea
    done: true
    description: Add aria-label="Send input to session" to the textarea in
      MessageInput.svelte.
  - title: Add aria-label to PrStatusSection refresh button
    done: true
    description: Add aria-label="Refresh PR status" to the icon-only refresh button
      in PrStatusSection.svelte.
  - title: Add skip-to-content link in root layout
    done: true
    description: Add a visually-hidden skip link as the first child of the root div
      in +layout.svelte, targeting id="main-content" placed on the content
      wrapper in the project layout. Use sr-only focus:not-sr-only Tailwind
      classes.
  - title: Improve end-session confirmation focus management
    done: true
    description: 'In SessionDetail.svelte: add role="alertdialog" and aria-label to
      the confirmation div. Use $effect+tick to focus the confirm button on
      open. Add onkeydown for Escape to cancel. Return focus to trigger button
      on cancel. Store a ref to the trigger button.'
  - title: Create keyboard shortcut utility
    done: true
    description: Create src/lib/utils/keyboard_shortcuts.ts with isTypingTarget()
      (checks input/textarea/select/contenteditable) and
      handleGlobalShortcuts(event, callbacks) supporting Ctrl+/ (suppressed in
      typing targets) and Ctrl+1/2/3 (always active). Use event.ctrlKey on all
      platforms.
  - title: Write tests for keyboard shortcut utility
    done: true
    description: Create src/lib/utils/keyboard_shortcuts.test.ts testing
      isTypingTarget with various element types, handleGlobalShortcuts with each
      key combo, suppression of Ctrl+/ in typing targets, and that Ctrl+1/2/3
      fires from any context. Follow keyboard_nav.test.ts patterns.
  - title: Wire keyboard shortcuts into root layout
    done: true
    description: Add svelte:window onkeydown in +layout.svelte. Ctrl+/ focuses the
      search input (found via data- attribute, no-op if not on Plans page).
      Ctrl+1/2/3 navigates to Sessions/Active/Plans tabs using goto() with
      projectUrl(). Add data-search-input attribute to PlansList search input.
  - title: "Address Review Feedback: The `taskCounts` refactor in `SessionDetail`
      introduced failure and state-sync bugs."
    done: true
    description: >-
      The `taskCounts` refactor in `SessionDetail` introduced failure and
      state-sync bugs. `getPlanTaskCounts({ planUuid }).then(...)` has no
      rejection handling, so a missing plan, transport failure, or server error
      becomes an unhandled promise rejection. It also leaves the previous
      `taskCounts` value in place while a new `planUuid` request is in flight,
      so the header can briefly show counts for the wrong plan after session
      metadata changes. This came from replacing the derived-based approach with
      an effect-driven fetch.


      Suggestion: Restore a derived-based async state pattern, or explicitly
      clear `taskCounts` before issuing the request and add a `.catch(...)` path
      that resets state. Add tests for a rejected `getPlanTaskCounts` call and
      for changing `planUuid` on an existing session.


      Related file: src/lib/components/SessionDetail.svelte:105-121
  - title: "Address Review Feedback: `Ctrl+/` is swallowed on every page, not just
      the Plans tab."
    done: true
    description: >-
      `Ctrl+/` is swallowed on every page, not just the Plans tab. In
      `handleGlobalShortcuts`, the shortcut is considered handled as soon as a
      `focusSearch` callback exists, and the root layout always passes one. On
      Sessions/Active pages, or during transitions before `PlansList` mounts,
      `document.querySelector('[data-search-input]')` returns null, so the code
      still calls `preventDefault()` and does nothing. The requirement was to
      focus search on the Plans page; this implementation hijacks the combo
      globally.


      Suggestion: Only register `focusSearch` when the current tab is `plans`,
      or change the callback contract so it returns whether focus actually moved
      and only call `preventDefault()` when it succeeds. Add an integration test
      for non-Plans routes.


      Related file: src/routes/+layout.svelte:47-52
  - title: "Address Review Feedback: Session task counts are now fetched in a
      client-only `$effect`, so `SessionDetail` no longer renders the `X/Y` task
      counts during SSR."
    done: true
    description: >-
      Session task counts are now fetched in a client-only `$effect`, so
      `SessionDetail` no longer renders the `X/Y` task counts during SSR. That
      regresses the already-shipped session-detail enhancement and the project's
      stated `query` + writable `$derived` pattern for this data. Refreshing or
      directly opening `/projects/{id}/sessions/{connectionId}` now drops the
      counts from the initial HTML until hydration finishes.


      Suggestion: Restore an SSR-compatible data path for `getPlanTaskCounts`
      instead of the manual `$effect` fetch. A writable async `$derived` or
      server-provided data would preserve initial render output while still
      handling refreshes safely.


      Related file: src/lib/components/SessionDetail.svelte:105-128
  - title: "Address Review Feedback: The plans page still has an unlabeled sort
      control."
    done: true
    description: >-
      The plans page still has an unlabeled sort control. The search input got
      an accessible name, but the adjacent `<select>` is still rendered without
      a visible `<label>` or `aria-label`, so screen readers only get the
      current option text with no indication that this control changes sort
      order.


      Suggestion: Add a visible label or `aria-label` such as `Sort plans`, or
      wrap the control in a labelled group.


      Related file: src/lib/components/PlansList.svelte:181-189
changedFiles:
  - CLAUDE.md
  - README.md
  - docs/web-interface.md
  - src/lib/components/FilterChips.svelte
  - src/lib/components/FilterChips.test.ts
  - src/lib/components/MessageInput.svelte
  - src/lib/components/PlansList.svelte
  - src/lib/components/PrStatusIndicator.svelte
  - src/lib/components/PrStatusIndicator.test.ts
  - src/lib/components/PrStatusSection.svelte
  - src/lib/components/PrStatusSection.test.ts
  - src/lib/components/ProjectSidebar.svelte
  - src/lib/components/PromptRenderer.svelte
  - src/lib/components/SessionDetail.svelte
  - src/lib/components/SessionDetail.test.ts
  - src/lib/components/SessionList.svelte
  - src/lib/components/TabNav.svelte
  - src/lib/utils/keyboard_shortcuts.test.ts
  - src/lib/utils/keyboard_shortcuts.ts
  - src/routes/+layout.svelte
  - src/routes/projects/[projectId]/+layout.svelte
  - src/routes/projects/[projectId]/sessions/[connectionId]/session_page.test.ts
tags:
  - web-ui
---

## Overview

The web UI has basic keyboard navigation (Alt+Arrow for lists) but lacks comprehensive accessibility support. This plan addresses ARIA labels, focus management, color-independent status indicators, and keyboard shortcuts.

## Key Features

- **ARIA labels**: Add `aria-label` and `role` attributes to interactive elements — status badges, action buttons, expand/collapse toggles, filter chips.
- **Focus management**: Trap focus in confirmation dialogs (workspace lock/unlock), return focus to trigger element on close.
- **Status indicators**: Add text labels or patterns alongside color-only status indicators so they're distinguishable without color vision.
- **Keyboard shortcuts**: Add shortcuts for common actions — focus search (Ctrl+/), navigate tabs (Ctrl+1/2/3). Escape dismisses the end-session confirmation when focused within it.
- **Skip navigation**: Add skip-to-content links for screen readers.

## Implementation Notes

- Audit all components for missing ARIA attributes
- Use a focus trap library or implement a simple one for dialog components
- StatusBadge already shows text — ensure contrast ratios meet WCAG AA
- The expand/collapse triangles (▶/▼) should also have `aria-expanded` attributes
- Test with VoiceOver on macOS for basic screen reader compatibility

## Expected Behavior/Outcome

After implementation, the web UI will be navigable by keyboard-only users and screen reader users:
- All interactive elements have proper ARIA labels and roles
- Status indicators convey meaning without relying on color alone
- Keyboard shortcuts provide efficient navigation (Ctrl+/ for search, Ctrl+1/2/3 for tabs, Escape for dismissal)
- Focus is properly managed in confirmation dialogs (end session confirmation)
- Skip navigation links allow bypassing the header and sidebar
- Expand/collapse controls communicate their state to assistive technology

## Key Findings

### Product & User Story
As a keyboard-only or screen reader user of the tim web interface, I want proper ARIA labels, keyboard shortcuts, and color-independent status indicators so I can efficiently navigate and manage plans, sessions, and workspaces without relying on a mouse or color vision.

### Design & UX Approach
- Incremental enhancement: existing UI remains visually unchanged; accessibility attributes are additive
- Keyboard shortcuts use standard conventions (Ctrl+/ for search is used by GitHub, VS Code, etc.)
- Status indicators gain screen-reader-only text labels rather than visual changes (StatusBadge already has visible text, PrStatusIndicator only has a colored dot)
- The confirmation dialog for ending sessions (inline in SessionDetail) gets proper focus management and ARIA live region announcements

### Technical Plan & Risks
- The project uses bits-ui for dialog primitives, which already handles focus trapping — the inline end-session confirmation in SessionDetail is custom and needs manual focus management
- The keyboard shortcut system needs to be context-aware (Ctrl+/ suppressed in text inputs; Ctrl+1/2/3 always active)
- Risk: Keyboard shortcuts could conflict with browser defaults or OS shortcuts; need careful key selection
- Risk: Adding `aria-expanded` to collapse buttons in SessionList/PlansList requires tracking expanded state at the button level

### Pragmatic Effort Estimate
This is a medium-sized effort spanning ~15 components and ~3 new utility modules. Most changes are small additions of ARIA attributes. The keyboard shortcut system and focus management are the most complex parts.

## Acceptance Criteria

- [ ] All interactive elements without visible text have `aria-label` attributes
- [ ] PrStatusIndicator colored dots have `aria-label` in addition to `title`
- [ ] Expand/collapse buttons in SessionList and PlansList have `aria-expanded` attributes
- [ ] FilterChips buttons have `aria-pressed` to indicate toggle state
- [ ] TabNav links have `aria-current="page"` on the active tab
- [ ] ProjectSidebar nav has `aria-label` and links have `aria-current` when selected
- [ ] Session status dot in SessionDetail has screen-reader text
- [ ] Skip-to-content link is present in the root layout, visually hidden until focused
- [ ] Keyboard shortcut Ctrl+/ focuses the search input on the Plans page
- [ ] Keyboard shortcuts Ctrl+1/2/3 navigate between Sessions/Active/Plans tabs
- [ ] Escape key dismisses the end-session confirmation when focus is within the confirmation bar
- [ ] Focus moves to the confirmation buttons when "End Session" is clicked, and returns to the trigger when cancelled
- [ ] MessageInput textarea has aria-label (Send button has visible text serving as accessible name)
- [ ] SessionMessage expand/collapse buttons have visible text serving as accessible names (no aria-label needed)
- [ ] PrStatusSection refresh button has aria-label
- [ ] Keyboard shortcut utility has tests covering shortcut registration, context awareness, and event handling
- [ ] All new ARIA attributes are tested via unit tests on the utility functions

## Dependencies & Constraints

- **Dependencies**: Uses existing bits-ui dialog/dropdown primitives (already in project). Existing `keyboard_nav.ts` utility for list navigation patterns.
- **Technical Constraints**: Ctrl+/ (focus search) must not fire when focus is in a text input, textarea, or contenteditable element (since / is typeable). Ctrl+1/2/3 (tab navigation) should work from any context. Must work in both light and dark themes. Must not break existing Alt+Arrow list navigation.

## Research

### Current State of Accessibility

The web UI has minimal accessibility support. The exploration identified the following areas:

#### What Works Well
1. **bits-ui primitives**: Dialog, Accordion, Dropdown Menu components from bits-ui have built-in focus trapping and ARIA attributes
2. **Focus styling**: All interactive elements have visible `focus-visible:ring` styling via Tailwind
3. **Some ARIA labels exist**: The theme toggle button has `aria-label="Toggle dark mode"`, terminal buttons in SessionRow/SessionDetail have `aria-label`, and the dropdown trigger in PlanDetail has `aria-label="More plan actions"`
4. **Semantic HTML**: `<nav>` elements used in ProjectSidebar and breadcrumbs, `<details>/<summary>` used in PrStatusSection
5. **Keyboard list navigation**: `keyboard_nav.ts` provides `isListNavEvent()` (Alt+Arrow), `getAdjacentItem()`, and `scrollListItemIntoView()` — used by SessionList and PlansList via `svelte:window onkeydown`

#### Components Audited and Findings

**StatusBadge.svelte** (`src/lib/components/StatusBadge.svelte`)
- Non-interactive `<span>` with colored background + visible text label
- Maps status → color class and status → label text
- **Finding**: Already has visible text; NOT color-only. No ARIA issues for sighted users, but the role could be more explicit for screen readers. Low priority.

**PrStatusIndicator.svelte** (`src/lib/components/PrStatusIndicator.svelte`)
- Small colored dot (`h-2 w-2 rounded-full`) with only `title` attribute
- Maps status → color (`passing: green, failing: red, pending: yellow, none: gray`)
- **Finding**: COLOR-ONLY indicator. Has `title` but no `aria-label`. Screen readers may not announce `title` consistently. Needs `aria-label` and `role="img"` to be accessible.

**PriorityBadge.svelte** (`src/lib/components/PriorityBadge.svelte`)
- Non-interactive `<span>` with colored background + visible text label ("Urgent", "High", etc.)
- **Finding**: Already has visible text. No issues.

**WorkspaceBadge.svelte** (`src/lib/components/WorkspaceBadge.svelte`)
- Non-interactive `<span>` with visible text labels ("Primary", "Auto", "Locked", "Available")
- **Finding**: Already has visible text. No issues.

**FilterChips.svelte** (`src/lib/components/FilterChips.svelte`)
- Toggle `<button>` elements for status filtering. Active state changes color class.
- **Finding**: Has visible text labels. Missing `aria-pressed` attribute to communicate toggle state to screen readers. Each button needs `aria-pressed={isActive}`.

**SessionList.svelte** (`src/lib/components/SessionList.svelte`)
- Group collapse/expand buttons with `▶`/`▼` triangle indicators
- Uses `svelte:window onkeydown` with `isListNavEvent()` for Alt+Arrow navigation
- **Finding**: Collapse buttons need `aria-expanded={!isCollapsed}` and `aria-label` (e.g., "Toggle {group.label} group"). The triangle is decorative and could use `aria-hidden`.

**PlansList.svelte** (`src/lib/components/PlansList.svelte`)
- Similar group collapse buttons with rotated `▶` triangle
- Search `<input>` and sort `<select>`
- Uses `svelte:window onkeydown` with `isListNavEvent()` for Alt+Arrow navigation
- **Finding**: Same as SessionList — collapse buttons need `aria-expanded` and `aria-label`. Search input needs `aria-label="Search plans"`.

**SessionRow.svelte** (`src/lib/components/SessionRow.svelte`)
- Row is an `<a>` tag. Has icon buttons with `aria-label` for terminal actions.
- Status dot: colored span with `aria-label="Needs attention"` for the attention indicator
- "Dismiss" button: has visible text "Dismiss" but no `aria-label`
- **Finding**: Generally good. The status dot next to the session name uses color only (green/blue/gray) — but there's also a separate text status shown. Minor: the Dismiss button text serves as its accessible name, which is fine.

**SessionDetail.svelte** (`src/lib/components/SessionDetail.svelte`)
- Status dot in header: `<span class="h-2.5 w-2.5 rounded-full {statusDotClass}">` — COLOR-ONLY, no aria-label
- "End Session" inline confirmation: custom implementation with two buttons ("End Session" + "Cancel") — no focus trapping, no `aria-live` announcement, no Escape handling
- Terminal buttons: already have `aria-label` and `title`
- **Finding**: Status dot needs `aria-label={statusText}` or a screen-reader-only span. The end-session confirmation needs: (1) focus moved to the confirmation area on open, (2) Escape to cancel, (3) focus returned to trigger on cancel, (4) `role="alertdialog"` or `aria-live="polite"` for the confirmation message.

**SessionMessage.svelte** (`src/lib/components/SessionMessage.svelte`)
- "Show more"/"Show less" buttons and "Show more"/"Show less" for key-value pairs
- Todo list items: colored Unicode symbols (✓ → ✗ ○) with color
- File changes: colored symbols (+, -, ~) with color
- **Finding**: Expand/collapse buttons are fine — they have visible text ("Show more (N more lines)"). Todo symbols use color + distinct symbols, which is adequate. File change symbols use +/-/~ which is text-based. Low priority for these.

**PromptRenderer.svelte** (`src/lib/components/PromptRenderer.svelte`)
- Confirm buttons (Yes/No), input fields, select/checkbox options
- **Finding**: Confirm buttons have visible text. Form inputs use proper `<label>` elements. Input has a `placeholder`. Relatively well-structured semantically.

**MessageInput.svelte** (`src/lib/components/MessageInput.svelte`)
- Textarea with placeholder + "Send" button
- **Finding**: Textarea has placeholder text. The button has visible text "Send". Adding `aria-label` to the textarea would be helpful since placeholder text isn't reliably announced. The button's visible text serves as accessible name.

**TabNav.svelte** (`src/lib/components/TabNav.svelte`)
- `<nav>` with `<a>` links for Sessions / Active Work / Plans
- Active state via visual styling only
- **Finding**: Missing `aria-current="page"` on the active tab link. The `<nav>` should have `aria-label="Main navigation"` to distinguish from other nav elements.

**ProjectSidebar.svelte** (`src/lib/components/ProjectSidebar.svelte`)
- `<nav>` with project links, selected state via background color
- **Finding**: Missing `aria-label` on the `<nav>` element. Missing `aria-current="page"` on the selected project link.

**PrStatusSection.svelte** (`src/lib/components/PrStatusSection.svelte`)
- Refresh button (icon only, no text), PR title link, expandable `<details>` elements
- **Finding**: Refresh button needs `aria-label="Refresh PR status"`. The `<details>/<summary>` elements are semantic and accessible by default.

**PrCheckRunList.svelte** (`src/lib/components/PrCheckRunList.svelte`)
- Status icons as Unicode symbols (◌, ✓, ✗, !, ⊘, —, ?) with colors
- Each has a text status label next to it (e.g., "In progress", "Pending")
- **Finding**: Has text labels alongside symbols. Adequate.

**PrReviewList.svelte** (`src/lib/components/PrReviewList.svelte`)
- State icons (✓, ✗, 💬, ◌, —) with colors, plus text state labels
- **Finding**: Has text labels alongside symbols. Adequate.

**Root Layout** (`src/routes/+layout.svelte`)
- Structure: `<header>` → `<main>` with `{@render children()}`
- No skip navigation link
- **Finding**: Needs a skip-to-content link before the header, visually hidden until focused.

**Project Layout** (`src/routes/projects/[projectId]/+layout.svelte`)
- Renders ProjectSidebar + content
- **Finding**: The `<main>` in root layout wraps both sidebar and content. The skip link target should be the main content area, not the sidebar.

#### Keyboard Navigation Architecture

The current `keyboard_nav.ts` provides only Alt+Arrow list navigation. For global keyboard shortcuts, a new system is needed:

- Must be context-aware: Ctrl+/ suppressed in typing targets (input/textarea/contenteditable); Ctrl+1/2/3 always active
- Uses Ctrl modifier on all platforms (not Cmd on Mac — avoids browser tab switching conflicts)
- Should be centralized for discoverability and conflict detection
- SessionList and PlansList already use `svelte:window onkeydown` — the new system should coexist

#### Testing Patterns

Existing tests in `src/lib/utils/keyboard_nav.test.ts` test pure utility functions by mocking `KeyboardEvent` objects and DOM APIs (`document.querySelector`, `CSS.escape`). Component-level tests (e.g., `SessionRow.test.ts`, `SessionMessage.test.ts`) exist but are logic-focused, not rendering tests. New accessibility tests should follow the utility-function testing pattern for the keyboard shortcut system and can test ARIA attribute logic where it's computed.

## Implementation Guide

### Phase 1: ARIA Labels and Semantic Attributes

**Step 1: PrStatusIndicator — Add aria-label and role**
- File: `src/lib/components/PrStatusIndicator.svelte`
- Add `aria-label={title}` and `role="img"` to the `<span>` element
- The `title` map already has good descriptions ("PR checks passing", etc.)

**Step 2: FilterChips — Add aria-pressed**
- File: `src/lib/components/FilterChips.svelte`
- Add `aria-pressed={isActive}` to each filter `<button>`
- This communicates toggle state to screen readers

**Step 3: SessionList — Add aria-expanded to collapse buttons**
- File: `src/lib/components/SessionList.svelte`
- Add `aria-expanded={!isCollapsed}` to the group toggle `<button>`
- Add `aria-label="Toggle {group.label} group"` to the button
- Mark the triangle `<span>` with `aria-hidden="true"`

**Step 4: PlansList — Add aria-expanded to collapse buttons**
- File: `src/lib/components/PlansList.svelte`
- Same pattern as SessionList: `aria-expanded` and `aria-label` on group buttons
- Add `aria-label="Search plans"` to the search input

**Step 5: TabNav — Add aria-current**
- File: `src/lib/components/TabNav.svelte`
- Add `aria-current={active ? 'page' : undefined}` to each `<a>` link
- Add `aria-label="Main navigation"` to the `<nav>` element

**Step 6: ProjectSidebar — Add aria-label and aria-current**
- File: `src/lib/components/ProjectSidebar.svelte`
- Add `aria-label="Project navigation"` to the `<nav>` element
- Add `aria-current={isSelected ? 'page' : undefined}` to project links and the "All Projects" link

**Step 7: SessionDetail — Add status dot accessibility**
- File: `src/lib/components/SessionDetail.svelte`
- Add `aria-label={statusText}` and `role="img"` to the status dot `<span>`
- Or add a `<span class="sr-only">{statusText}</span>` next to it

**Step 8: MessageInput — Add aria-label to textarea**
- File: `src/lib/components/MessageInput.svelte`
- Add `aria-label="Send input to session"` to the `<textarea>`

**Step 9: PrStatusSection — Add aria-label to refresh button**
- File: `src/lib/components/PrStatusSection.svelte`
- Add `aria-label="Refresh PR status"` to the refresh `<button>`

### Phase 2: Skip Navigation

**Step 10: Add skip-to-content link in root layout**
- File: `src/routes/+layout.svelte`
- Add an `<a>` link as the first child of the root `<div>`, before `<header>`
- Link text: "Skip to main content"
- Target: Add `id="main-content"` to a wrapper inside `<main>` (after sidebar, around the actual content area)
- Styling: Visually hidden until focused using `sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-background focus:p-2 focus:text-foreground`

The content target should be placed on the slot/children area rather than `<main>` since `<main>` also contains the sidebar. This means adding the `id` in the project layout (`src/routes/projects/[projectId]/+layout.svelte`) on the content wrapper div.

### Phase 3: Focus Management for End-Session Confirmation

**Step 11: Improve end-session confirmation dialog**
- File: `src/lib/components/SessionDetail.svelte`
- When `confirmingEndSession` becomes true:
  - Add `role="alertdialog"` and `aria-label="Confirm end session"` to the confirmation `<div>`
  - Use `$effect` to focus the "End Session" (confirm) button after the DOM updates (use `tick()` then `.focus()`)
  - Add an `onkeydown` handler on the confirmation div: Escape calls `handleCancelEndSession()`
- When cancelled, return focus to the "End Session" trigger button (store a ref to it, focus on cancel)
- Note: This is an inline confirmation, not a modal dialog. Full focus trapping is NOT needed — the user can still interact with other parts of the page. We just want to guide focus helpfully.

### Phase 4: Keyboard Shortcuts

**Step 12: Create keyboard shortcut utility**
- File: `src/lib/utils/keyboard_shortcuts.ts` (new file)
- Create a function `isTypingTarget(event: KeyboardEvent): boolean` that returns `true` if the event target is an `<input>`, `<textarea>`, `<select>`, or `[contenteditable]` element — used to suppress Ctrl+/ (which types a character) but NOT Ctrl+1/2/3 (which don't)
- Create a function `handleGlobalShortcuts(event: KeyboardEvent, callbacks: ShortcutCallbacks): void` that matches key combinations and calls the appropriate callback. Ctrl+/ is suppressed in typing targets; Ctrl+1/2/3 fires from any context.
- Define the `ShortcutCallbacks` interface with optional callbacks for each shortcut:
  - `focusSearch?: () => void` — Ctrl+/ (suppressed in text inputs)
  - `navigateTab?: (tabIndex: number) => void` — Ctrl+1/2/3 (always active)
- Use `event.ctrlKey` on all platforms (Cmd+number conflicts with browser tab switching on Mac, so Ctrl is safer universally)

**Step 13: Write tests for keyboard shortcut utility**
- File: `src/lib/utils/keyboard_shortcuts.test.ts` (new file)
- Test `isShortcutTarget` with various element types (input, textarea, select, contenteditable, div, button)
- Test `handleGlobalShortcuts` with each shortcut key combination
- Test that shortcuts don't fire when `isShortcutTarget` returns false
- Test that Ctrl modifier is required (not Meta/Cmd)
- Follow the pattern in `keyboard_nav.test.ts` for mocking `KeyboardEvent`

**Step 14: Wire keyboard shortcuts into the root layout**
- File: `src/routes/+layout.svelte`
- Add `<svelte:window onkeydown={handleShortcuts} />` in the root layout
- Implement `handleShortcuts` using the utility from Step 12
- For `focusSearch`: dispatch a custom event or use a shared store/callback that PlansList listens to. Simplest approach: use `document.querySelector` to find the search input by a `data-` attribute and focus it
- For `navigateTab`: use SvelteKit's `goto()` to navigate to the appropriate tab URL using `projectUrl(projectId, tabSlug)`
- For `escape`: this is handled locally in SessionDetail (Step 11), so it doesn't need global wiring

### Phase 5: Testing

**Step 15: Test ARIA attributes**
- Add tests to verify the utility functions produce correct ARIA values
- For the keyboard shortcuts utility: comprehensive tests as described in Step 13
- For components with computed ARIA attributes: test the derivation logic if it's non-trivial

### Manual Testing Checklist (not automated)
- Tab through all interactive elements on each page — verify visible focus ring
- Use VoiceOver on macOS to navigate SessionList, PlansList, and PlanDetail
- Verify Ctrl+/ focuses search on Plans page
- Verify Ctrl+1/2/3 switches tabs
- Verify Escape cancels end-session confirmation
- Verify skip-to-content link appears on focus and navigates correctly
- Verify PrStatusIndicator announces its status via VoiceOver
- Verify FilterChips announce pressed/unpressed state

## Current Progress
### Current State
- All 18 tasks complete. Plan is done.
### Completed (So Far)
- Task 1: PrStatusIndicator — aria-label={title} and role="img"
- Task 2: FilterChips — aria-pressed={isActive}
- Task 3: SessionList — aria-expanded, aria-label, aria-hidden on triangle
- Task 4: PlansList — aria-expanded, aria-label, aria-hidden on triangle, search input aria-label
- Task 5: TabNav — aria-current="page" on active tab, aria-label on nav
- Task 6: ProjectSidebar — aria-current="page" on selected links, aria-label on nav
- Task 7: SessionDetail — aria-label={statusText} and role="img" on status dot
- Task 8: MessageInput — aria-label on textarea
- Task 9: PrStatusSection — dynamic aria-label on refresh button (tracks refreshing state)
- Tests added for PrStatusIndicator, PrStatusSection, and FilterChips ARIA attributes
- Task 10: Skip-to-content link in root layout with tabindex="-1" and focus:outline-none on target
- Task 11: End-session confirmation focus management — role="alertdialog", Escape handler, focus on open/cancel with tick()
- SessionDetail.test.ts created with 6 ARIA attribute tests
- Fixed pre-existing SSR bug: replaced async $derived with $effect+$state pattern for taskCounts, with stale-response guard
- Task 12: Keyboard shortcut utility — isTypingTarget() and handleGlobalShortcuts() using event.code for locale independence
- Task 13: 26 tests covering all shortcut combos, typing target suppression, modifier rejection, missing callbacks
- Task 14: Root layout wiring with svelte:window onkeydown, PlansList data-search-input attribute
- Task 15: taskCounts fix — clear to null before fetch, add .catch() handler with cancellation guard
- Task 16: focusSearch returns boolean — preventDefault only called when focus actually moved; layout callback returns true/false based on querySelector result
- Task 18: PlansList sort select — added aria-label="Sort plans"
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- PrStatusSection refresh button uses dynamic aria-label that tracks refreshing state, rather than static label as originally planned. This avoids a screen reader announcing stale state.
- Used role="alertdialog" (not role="alert") for the end-session confirmation since it prompts for user response. Added tabindex="-1" to satisfy Svelte's a11y requirement that alertdialog elements be focusable.
- Skip link target uses tabindex="-1" and focus:outline-none to be programmatically focusable without visible focus ring artifact.
- Keyboard shortcuts use event.code (physical key codes like 'Slash', 'Digit1') instead of event.key for locale independence. Shift modifier is allowed to support layouts where these keys require Shift.
- Static tab map hoisted to module-level constant to avoid per-keydown allocation.
- focusSearch callback changed from () => void to () => boolean so preventDefault is only called when focus actually moved. This prevents Ctrl+/ from being swallowed on non-Plans pages.
- Acceptance criteria relaxed for MessageInput Send button and SessionMessage expand/collapse buttons: these have visible text serving as accessible names, so explicit aria-labels are unnecessary per WCAG guidelines.
### Lessons Learned
- When adding aria-label to elements that already have visible text, the label must be dynamic if the visible text changes with state — otherwise screen readers announce stale names.
- In Svelte {#if}/{:else} blocks with bind:this refs, always await tick() before accessing refs created by a block transition — the ref won't be populated until Svelte updates the DOM.
- Skip-to-content link targets need tabindex="-1" to be focusable; a plain div with just an id won't receive focus.
- When replacing async $derived with $effect+promise, guard the .then() callback against stale responses using the $effect cleanup pattern with a cancelled flag.
- Use event.code instead of event.key for keyboard shortcuts to avoid locale-dependent matching. event.key varies by layout; event.code reflects physical key position.
- Buttons with visible text content already have accessible names and don't need redundant aria-labels.
- When a callback determines whether an event should be suppressed, have the callback return a boolean instead of unconditionally calling preventDefault(). This avoids hijacking key combos on pages where the action has no effect.
- In $effect-driven async fetches, always clear the state to null before issuing the request AND add .catch() to handle rejections. Both are needed: clearing prevents stale data display, .catch() prevents unhandled promise rejections.
### Risks / Blockers
- None
