---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: convert API routes to remote functions instead
goal: ""
id: 246
uuid: 692590c4-90bd-4ed3-bb87-8503c49123fe
status: done
priority: medium
createdAt: 2026-03-20T23:42:35.963Z
updatedAt: 2026-03-21T01:25:08.775Z
tasks:
  - title: Create remote command functions for all 4 session API routes
    done: false
    description: Add remote command functions to session_actions.remote.ts
    status: done
    details: >
      Add remote command functions to src/lib/remote/session_actions.remote.ts
      for:

      - sendPromptResponse(connectionId, requestId, value)

      - sendUserInput(connectionId, content)

      - dismissSession(connectionId)

      - dismissInactiveSessions()


      Use zod schemas for validation. For sendPromptResponse, the value field is
      z.unknown().

      For error cases (not found, bad request), throw errors since remote
      functions don't return HTTP responses.

      dismissInactiveSessions should return the count of dismissed sessions.
  - title: Update client-side code to use remote functions instead of fetch
    done: false
    description: Replace fetch calls in session_state.svelte.ts with remote function imports
    status: done
    details: >
      Update src/lib/stores/session_state.svelte.ts to:

      - Import the new remote functions from session_actions.remote.js

      - Replace fetch calls in sendPromptResponse, sendUserInput,
      dismissSession, dismissInactiveSessions

      - Remove the sessionActionUrl helper method (no longer needed)

      - Handle errors from remote functions (they throw instead of returning
      HTTP status codes)

      - Keep the same boolean return type for the public methods
  - title: Delete old API route files and clean up unused helpers
    done: false
    description: Remove old API route files and unused session_routes.ts helpers
    status: done
    details: >
      Delete these API route files (keep the SSE events route):

      - src/routes/api/sessions/[connectionId]/input/+server.ts

      - src/routes/api/sessions/[connectionId]/dismiss/+server.ts

      - src/routes/api/sessions/[connectionId]/respond/+server.ts

      - src/routes/api/sessions/dismiss-inactive/+server.ts


      Clean up src/lib/server/session_routes.ts:

      - Remove helpers that are no longer used: parseJsonBody, badRequest,
      notFound, success, isRecord, isString

      - Keep SSE-related functions: formatSseEvent, createSessionEventsResponse
  - title: Update tests for the new remote function implementation
    done: false
    description: Rewrite tests to test remote functions instead of API routes
    status: done
    details: >
      Update or rewrite tests:

      - src/routes/api/sessions/actions.server.test.ts - rewrite to test remote
      functions directly

      - src/lib/server/session_integration.test.ts - update the route test
      section to use remote functions

      - Ensure existing test coverage is maintained (validation, error cases,
      prefix_select, etc.)
tags: []
---

All /api routes except for the SSE ones should be converted to remote `command` or `form` remote SvelteKit functions instead.

## Current Progress
### Current State
- All tasks complete. All 4 session API routes converted to remote `command` functions.
### Completed (So Far)
- Created remote command functions in `src/lib/remote/session_actions.remote.ts`: `sendSessionPromptResponse`, `sendSessionUserInput`, `dismissSession`, `dismissInactiveSessions`
- Updated `src/lib/stores/session_state.svelte.ts` to call remote functions instead of fetch
- Deleted 4 old API route files and cleaned up unused helpers in `session_routes.ts`
- Rewrote tests: `src/lib/remote/session_actions.remote.test.ts` (server-side), store-level tests in `session_state.test.ts`, updated integration tests
- Extracted shared `invokeCommand` test helper to `src/lib/test-utils/invoke_command.ts`
- Updated `docs/web-interface.md` to reflect new remote function architecture
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Used `z.unknown()` for the `value` field in prompt responses since it can be boolean, object (prefix_select), etc.
- Remote functions throw SvelteKit `error()` for not-found/bad-request cases; client wrappers catch and return false
- `dismissInactiveSessions` returns `{ dismissed: number }` to preserve the count information
### Lessons Learned
- SvelteKit remote `command()` functions need a request store context when testing. Use `with_request_store` from `@sveltejs/kit/internal/server` with `allows_commands: true` in the state.
- `import { z } from 'zod'` can resolve incorrectly under Vitest server runtime; use `import * as z from 'zod'` as a workaround.
### Risks / Blockers
- None
