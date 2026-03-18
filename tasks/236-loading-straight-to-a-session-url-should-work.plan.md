---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: loading straight to a session URL should work
goal: ""
id: 236
uuid: d5708664-ad99-4cea-9279-48594eb5e63a
simple: true
status: done
priority: medium
createdAt: 2026-03-18T20:52:58.693Z
updatedAt: 2026-03-18T23:50:26.097Z
tasks:
  - title: "Address Review Feedback: The new `initialized` flag becomes true too
      early to make the redirect safe."
    done: true
    description: |-
      The new `initialized` flag becomes true too early to make the redirect safe. [`session_state_events.ts`](/Users/dimfeld/Documents/projects/llmutils/src/lib/stores/session_state_events.ts#L75) sets `initialized = true` as soon as `session:list` is processed. But [`session_routes.ts`](/Users/dimfeld/Documents/projects/llmutils/src/lib/server/session_routes.ts#L62) explicitly buffers post-subscription events and sends them after the snapshot. If the target session is created or updated in that window, the page effect in [`+page.svelte`](/Users/dimfeld/Documents/projects/llmutils/src/routes/projects/[projectId]/sessions/[connectionId]/+page.svelte#L17) can still redirect away after `session:list` and before the buffered `session:new` or `session:update` arrives. This does not satisfy the plan requirement to redirect only after the session manager has actually loaded the session.

      Suggestion: Do not use `session:list` alone as the readiness signal. Add an explicit end-of-initial-sync event after buffered replay is drained, or send snapshot plus catch-up as one atomic initial payload and gate redirects on that.

      Related file: src/lib/stores/session_state_events.ts:75-82
  - title: 'Address Review Feedback: Direct session URLs still render an incorrect
      "Session not found" state before any session data has loaded.'
    done: true
    description: |-
      Direct session URLs still render an incorrect "Session not found" state before any session data has loaded. [`+page.svelte`](/Users/dimfeld/Documents/projects/llmutils/src/routes/projects/[projectId]/sessions/[connectionId]/+page.svelte#L24) renders the fallback whenever `session` is null, and `session` stays null until the first SSE snapshot arrives. On a full reload this is guaranteed SSR output, because the page has no session data server-side. The redirect bug is masked, but the page still treats "not loaded yet" as "missing", which is the same state conflation that caused the original problem.

      Suggestion: Gate the fallback on `sessionManager.initialized` and show a loading state before initialization instead of rendering `Session not found` immediately.

      Related file: src/routes/projects/[projectId]/sessions/[connectionId]/+page.svelte:24-31
changedFiles:
  - CLAUDE.md
  - docs/executor-stdin-conventions.md
  - docs/testing.md
  - docs/web-interface.md
  - package.json
  - src/lib/components/SessionDetail.svelte
  - src/lib/server/session_integration.test.ts
  - src/lib/server/session_manager.test.ts
  - src/lib/server/session_manager.ts
  - src/lib/server/session_routes.test.ts
  - src/lib/server/session_routes.ts
  - src/lib/stores/session_group_utils.ts
  - src/lib/stores/session_state.svelte.ts
  - src/lib/stores/session_state.test.ts
  - src/lib/stores/session_state_events.test.ts
  - src/lib/stores/session_state_events.ts
  - src/logging/headless_adapter.test.ts
  - src/logging/headless_adapter.ts
  - src/routes/projects/[projectId]/active/+layout.svelte
  - src/routes/projects/[projectId]/plans/+layout.svelte
  - src/routes/projects/[projectId]/sessions/+layout.svelte
  - src/routes/projects/[projectId]/sessions/[connectionId]/+page.svelte
  - src/routes/projects/[projectId]/sessions/[connectionId]/session_page.test.ts
  - src/tim/commands/agent/agent.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/list.test.ts
  - src/tim/commands/list.ts
  - src/tim/commands/set.test.ts
  - src/tim/commands/set.ts
  - src/tim/executors/claude_code/terminal_input_lifecycle.test.ts
  - src/tim/executors/claude_code/terminal_input_lifecycle.ts
  - src/tim/executors/codex_cli/app_server_runner.test.ts
  - src/tim/executors/codex_cli/app_server_runner.ts
  - src/tim/tim.ts
tags: []
---

When reloading the web app with a session ID in the url like `http://localhost:5174/projects/3/sessions/3a38c5ae-a407-4527-9df5-094550aec6f9` we are redirecting away from it because we haven't loaded the sessions yet. 

This should only happen if the session manager has actually loaded the session. I think this whole thing is designed to
make the dismiss button work properly; it would be better perhaps if dismiss would just `goto` a link away from the
session if dismissing the current session, instead of relying on the session detail page to handle it.

## Current Progress
### Current State
- All tasks complete
### Completed (So Far)
- Added `initialized` flag to `SessionManager` that tracks whether the initial SSE sync is complete
- Added `session:sync-complete` SSE event sent after snapshot + buffered event replay, replacing premature `session:list`-based initialization
- Moved `setInitialized(true)` from `session:list` handler to new `session:sync-complete` handler in `session_state_events.ts`
- Gated the session detail page redirect on `sessionManager.initialized` so it only redirects after sessions have actually loaded
- Session detail page now shows "Loading..." before initialization instead of "Session not found"
- Reset `initialized` to `false` on SSE reconnect to avoid stale state
- Added tests for `session:sync-complete` event ordering and page loading states
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Chose the `initialized` flag approach over moving dismiss-redirect logic into the dismiss button itself. The flag approach is simpler and fixes the root cause (premature redirect before data loads) without changing the dismiss flow.
- Used a dedicated `session:sync-complete` event rather than bundling buffered events into the `session:list` payload, keeping the SSE protocol simple and backward-compatible.
### Lessons Learned
- SSE events are processed as separate browser event loop tasks, so Svelte effects can fire between `session:list` and subsequent buffered events. An explicit "sync complete" signal after all catch-up events are sent is the reliable way to gate on initialization.
### Risks / Blockers
- None
