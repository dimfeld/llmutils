---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: support pwa badge API
goal: ""
id: 244
uuid: 4d869df3-59e3-4a43-8172-0e7131e030b9
generatedBy: agent
status: pending
priority: medium
planGeneratedAt: 2026-03-20T21:04:46.615Z
promptsGeneratedAt: 2026-03-20T21:04:46.615Z
createdAt: 2026-03-20T20:31:31.513Z
updatedAt: 2026-03-20T21:04:46.615Z
tasks:
  - title: Create PWA badge utility module
    done: false
    description: Create `src/lib/utils/pwa_badge.ts` with `setAppBadge()` and
      `clearAppBadge()` functions. Each should feature-detect
      `navigator.setAppBadge`/`navigator.clearAppBadge`, call the API if
      available, and silently catch any rejected Promises. No-op when the API is
      unavailable.
  - title: Add needsAttention derived property to SessionManager
    done: false
    description: Add a `needsAttention = $derived.by(...)` property to
      `SessionManager` in `src/lib/stores/session_state.svelte.ts`. It should
      iterate `this.sessions.values()` and return `true` if any session has
      `activePrompt !== null` OR `status === "notification"`. This is global
      across all projects.
  - title: Add badge effect in root layout
    done: false
    description: In `src/routes/+layout.svelte`, add an `$effect` that watches
      `sessionManager.needsAttention` and calls `setAppBadge()` when true,
      `clearAppBadge()` when false. Import from the new utility module. Also
      call `clearAppBadge()` in the cleanup function returned from `onMount`.
  - title: Write tests for pwa_badge utility
    done: false
    description: "Create `src/lib/utils/pwa_badge.test.ts`. Test: (1)
      `setAppBadge()` calls `navigator.setAppBadge()` when available, (2)
      `clearAppBadge()` calls `navigator.clearAppBadge()` when available, (3)
      both are no-ops when API is unavailable (no error thrown), (4) rejected
      Promises are caught silently."
  - title: Write tests for needsAttention derived state
    done: false
    description: 'Add tests in `src/lib/stores/session_state.test.ts` for the
      `needsAttention` property. Test: (1) returns false with no sessions, (2)
      returns true when a session has activePrompt, (3) returns true when a
      session has status "notification", (4) returns false when sessions exist
      but none need attention, (5) transitions correctly when prompts are
      cleared or sessions dismissed.'
tags: []
---

Support navigator.setAppBadge() / navigator.clearAppBadge() in the web app. If there are any unhandled notifications, show a red dot. No
need for the number

## Expected Behavior/Outcome

When the PWA is installed and running, the app icon in the dock/taskbar should display a badge dot whenever there are sessions that need the user's attention. The badge should clear automatically when all attention-requiring sessions are resolved.

**States:**
- **Badge shown**: At least one session has an `activePrompt` (waiting for user input) OR has `status === 'notification'` (unhandled notification message)
- **Badge cleared**: No sessions need attention (all prompts answered, all notifications dismissed or sessions disconnected)

## Key Findings

### Product & User Story
As a user running multiple tim agent sessions, I want the PWA app icon to show a badge when any session needs my attention, so I can quickly see at a glance whether I need to switch to the tim app without checking each session individually.

### Design & UX Approach
- Use `navigator.setAppBadge()` (no argument) for a simple dot indicator — no count needed
- Badge updates reactively as SSE events arrive (prompts, clears, disconnects, dismissals)
- No additional UI elements needed — the badge is an OS-level indicator on the app icon
- Graceful degradation: if the Badge API is not supported (non-PWA context, unsupported browser), silently skip

### Technical Plan & Risks
- The Badge API is well-supported in Chromium browsers (Chrome, Edge) when installed as PWA. Safari support is limited.
- `navigator.setAppBadge()` and `navigator.clearAppBadge()` return Promises but failures should be silently caught
- The implementation should be reactive to the session store's state, not manually tracking counts
- Main risk: ensuring the badge is always in sync — every code path that changes "needs attention" state must trigger a re-evaluation

### Pragmatic Effort Estimate
Small feature — 1-2 files to modify, ~50-80 lines of new code, plus tests.

## Acceptance Criteria

- [ ] PWA badge dot appears when any session has an active prompt
- [ ] PWA badge dot appears when any session has `status === 'notification'`
- [ ] PWA badge clears when the last attention-needing session is resolved
- [ ] Badge updates in real-time as SSE events arrive
- [ ] Gracefully handles browsers/contexts where Badge API is unavailable
- [ ] All new code paths are covered by tests

## Dependencies & Constraints

- **Dependencies**: Relies on existing `SessionManager` reactive state and `initSessionNotifications` event system
- **Technical Constraints**: Badge API requires secure context (HTTPS or localhost). Only works in installed PWA context on most platforms. Must not break existing browser notification behavior.

## Implementation Notes

### Recommended Approach
Add a reactive `$effect` or `$derived` in the root layout (or a dedicated module initialized alongside session notifications) that computes whether any session needs attention, and calls `setAppBadge()`/`clearAppBadge()` accordingly. Alternatively, integrate into `initSessionNotifications` since it already handles all the relevant SSE events.

### Potential Gotchas
- `navigator.setAppBadge` may not exist — must feature-detect
- The API returns a Promise that can reject (e.g., if not in a secure context or PWA) — must catch
- Need to handle the initial `session:list` sync event to set the correct badge state on page load/reconnect
- Must handle SSE reconnection: badge state should re-derive from the full session list, not just incremental events

## Research

### Overview
The task is to integrate the PWA Badging API (`navigator.setAppBadge()` / `navigator.clearAppBadge()`) so that the installed PWA's app icon shows a dot when any session needs user attention.

### Critical Discoveries

1. **Session attention model**: The codebase has a clear concept of "needs attention" already:
   - `activePrompt !== null` on any `SessionData` = user input required
   - `status === 'notification'` on a session = unhandled notification message
   These are the two conditions that should trigger the badge.

2. **Reactive state infrastructure**: `SessionManager` (in `src/lib/stores/session_state.svelte.ts`) uses Svelte 5 runes (`$state`, `$derived`) and a `SvelteMap` for sessions. A `$derived` computation can efficiently check if any session needs attention.

3. **Event system**: `SessionManager.onEvent()` allows subscribing to all SSE events. `initSessionNotifications()` already subscribes and handles all the relevant events (prompt, prompt-cleared, disconnect, dismissed, list reconciliation). Badge logic can follow the same pattern.

4. **Root layout initialization**: `src/routes/+layout.svelte` is where the `SessionManager` is created, SSE connection started, and `initSessionNotifications` called. This is the natural place to add badge management.

### Notable Files Inspected

- **`src/lib/stores/session_state.svelte.ts`**: The `SessionManager` class. Has `sessions` (SvelteMap), `initialized` flag, `onEvent()` for subscribing to SSE events. The `sessions` map is reactive — iterating it in a `$derived` block will re-evaluate when sessions change.

- **`src/lib/stores/session_notifications.ts`**: `initSessionNotifications()` handles browser Notification API integration. Subscribes to SSE events, shows/closes OS notifications. This is a peer module — badge management can follow the same pattern as a separate `initBadgeManager()` function.

- **`src/lib/utils/browser_notifications.ts`**: Utility layer for browser Notification API. Tracks active notifications by tag. The badge feature doesn't need this module directly but follows a similar "utility wrapper" pattern.

- **`src/lib/types/session.ts`**: Defines `SessionData` with `activePrompt: ActivePrompt | null` and `status: SessionStatus` (`'active' | 'offline' | 'notification'`).

- **`src/routes/+layout.svelte`**: Root layout. Creates `SessionManager`, calls `sessionManager.connect()`, calls `initSessionNotifications()`. Cleanup on unmount. This is where badge initialization should go.

- **`src/service-worker.ts`**: Simple cache-first strategy for static assets, network-only for API. No badge-related code. The Badge API is called from the main thread, not the service worker, so no changes needed here.

- **`static/manifest.webmanifest`**: Standard PWA manifest with `display: standalone`. No changes needed for badge support.

### Architectural Considerations

**Approach A: Reactive `$effect` in root layout**
- Add a `$derived` that computes `needsAttention` from `sessionManager.sessions`
- Add an `$effect` that calls `setAppBadge()`/`clearAppBadge()` based on the derived value
- Pro: Simple, leverages Svelte reactivity, automatically stays in sync
- Con: Couples badge logic to the layout component

**Approach B: Event-driven in a dedicated module (like session_notifications.ts)**
- Create `initBadgeManager(sessionManager)` that subscribes to `onEvent()` and manually tracks state
- Pro: Separated concern, testable in isolation
- Con: Must manually replicate the "any session needs attention" check on every event, risk of getting out of sync

**Recommended: Approach A** — A small `$effect` in the layout is the simplest and most reliable approach. The reactive system guarantees synchronization. The badge utility functions can be extracted to a small utility file for testability.

### Edge Cases
- **SSE reconnection**: On reconnect, `session:list` replaces all sessions. The `$derived` will naturally re-compute.
- **Page load**: Badge should be set on initial load if sessions already need attention. The `$derived` handles this once `initialized` becomes true.
- **Multiple tabs**: Each tab will call `setAppBadge()` independently, but this is idempotent and harmless.
- **Browser support**: `navigator.setAppBadge` may be undefined. Feature-detect before calling.

## Implementation Guide

### Step 1: Create Badge Utility Module

Create `src/lib/utils/pwa_badge.ts` with two functions:

```typescript
export function setAppBadge(): void { ... }
export function clearAppBadge(): void { ... }
```

Each function should:
1. Check if `navigator.setAppBadge` / `navigator.clearAppBadge` exists (feature detection)
2. Call the API and catch any rejected Promise (silently — logging a warning at most)

This module is small but worth extracting for:
- Testability (can mock/spy on it)
- Reusability if badge logic is needed elsewhere
- Clean feature detection in one place

### Step 2: Add "Needs Attention" Computation to SessionManager

Add a `$derived` property to `SessionManager` in `src/lib/stores/session_state.svelte.ts`:

```typescript
needsAttention = $derived.by(() => {
  for (const session of this.sessions.values()) {
    if (session.activePrompt) return true;
    if (session.status === 'notification') return true;
  }
  return false;
});
```

This is reactive — it will re-evaluate whenever any session's `activePrompt` or `status` changes in the `SvelteMap`.

### Step 3: Add Badge Effect in Root Layout

In `src/routes/+layout.svelte`, inside the `<script>` block, add an `$effect` after the existing effects:

```typescript
$effect(() => {
  if (sessionManager.needsAttention) {
    setAppBadge();
  } else {
    clearAppBadge();
  }
});
```

Import `setAppBadge` and `clearAppBadge` from the new utility module.

This is the entire integration — the reactive system handles all edge cases (reconnection, initial load, session changes).

### Step 4: Write Tests

**Unit test for `pwa_badge.ts`**:
- Test that `setAppBadge()` calls `navigator.setAppBadge()` when available
- Test that `clearAppBadge()` calls `navigator.clearAppBadge()` when available
- Test that both are no-ops when the API is unavailable
- Test that rejected Promises are caught silently

**Unit test for `needsAttention` derived state**:
- Test returns `false` when no sessions exist
- Test returns `true` when a session has `activePrompt`
- Test returns `true` when a session has `status === 'notification'`
- Test returns `false` when sessions exist but none need attention (active with no prompt, offline)
- Test transitions from `true` to `false` when the last prompt is cleared

The `needsAttention` tests should be added to `src/lib/stores/session_state.test.ts` if it exists, or to the session state events test file.

### Step 5: Manual Testing

1. Run `bun run dev` and install the PWA (Chrome: three-dot menu → "Install app")
2. Start an agent session that will eventually prompt for input
3. Verify the app icon shows a badge dot when the prompt appears
4. Answer the prompt and verify the badge clears
5. Test with multiple sessions — badge should persist until all are resolved
6. Test in a non-PWA context (regular browser tab) — should not error
