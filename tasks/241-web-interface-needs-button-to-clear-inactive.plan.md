---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: web interface needs button to clear inactive sessions and one-off notifications
goal: ""
id: 241
uuid: 1d23225a-a965-45fc-ba9d-e0b9d20f7fb3
simple: true
status: done
priority: medium
createdAt: 2026-03-19T08:14:30.788Z
updatedAt: 2026-03-20T22:43:07.974Z
tasks:
  - title: Add dismissInactiveSessions method and API route
    done: true
    description: Add server-side bulk dismiss method and API endpoint
  - title: Add client-side method and UI button
    done: true
    description: Add client store method and Clear Inactive button to sessions layout
changedFiles:
  - src/lib/server/session_manager.test.ts
  - src/lib/server/session_manager.ts
  - src/lib/stores/session_state.svelte.ts
  - src/routes/api/sessions/dismiss-inactive/+server.ts
  - src/routes/projects/[projectId]/sessions/+layout.svelte
tags: []
---

## Current Progress
### Current State
- All tasks complete. Feature fully implemented and verified.
### Completed (So Far)
- Server-side `dismissInactiveSessions()` method on SessionManager that bulk-removes all offline/notification sessions
- POST `/api/sessions/dismiss-inactive` API route
- Client-side `dismissInactiveSessions()` method on the store SessionManager
- "Clear Inactive" button in sessions layout header, conditionally visible when inactive sessions exist
- 3 new tests for the server-side method
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Reused existing `dismissSession` pattern (delete from sessions/senders/internals maps, emit session:dismissed per session) for consistency with SSE event flow
### Lessons Learned
- None
### Risks / Blockers
- None
