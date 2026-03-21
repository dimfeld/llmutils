---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Background PR Polling
goal: ""
id: 249
uuid: 8c93ae87-992a-440a-bfaf-93898d93d21b
generatedBy: agent
status: pending
priority: medium
dependencies:
  - 248
parent: 245
references:
  "245": 50487743-93a6-45c0-bda9-ce9e19100c92
  "248": f92da2f3-c73f-4b89-83c8-03b509d58d1d
planGeneratedAt: 2026-03-21T02:29:15.783Z
promptsGeneratedAt: 2026-03-21T02:29:15.783Z
createdAt: 2026-03-21T02:25:00.027Z
updatedAt: 2026-03-21T02:29:15.784Z
tasks:
  - title: Create background PR polling service
    done: false
    description: "Create src/lib/server/pr_polling.ts: polling loop that queries DB
      for active plans (in_progress, needs_review) with linked PRs via
      getPlansWithPrs(). Deduplicate PR URLs across plans. Use lightweight
      fetchPrCheckStatus() for frequent polling. Configurable interval (default
      5 minutes). Exponential backoff on errors (double interval on failure,
      reset on success, cap at 30 minutes). Graceful degradation when
      GITHUB_TOKEN unavailable (disable polling, log warning)."
  - title: Implement GitHub API rate limit management
    done: false
    description: Add rate limit tracking to the polling service. Monitor
      X-RateLimit-Remaining and X-RateLimit-Reset headers from GitHub API
      responses. Budget requests per polling interval based on remaining quota.
      If approaching limit, increase polling interval dynamically. Log rate
      limit warnings. Expose rate limit info for debugging (CLI or web
      endpoint).
  - title: Add SSE events for PR status updates
    done: false
    description: Extend SSE event system with pr:status-update event type containing
      plan UUID and updated check status. Emit events from polling service when
      check status changes (compare before/after state). Update
      src/lib/stores/session_state.svelte.ts (or create separate pr_status
      store) to handle pr:status-update events. PlanDetail and list views
      reactively update when status changes without page reload.
  - title: Integrate polling service with web server lifecycle
    done: false
    description: Start polling service on server init in src/hooks.server.ts
      (alongside WebSocket server). Register SIGTERM/SIGINT handlers to stop
      polling. Handle HMR restarts gracefully (use Symbol.for pattern like
      session_context.ts for singleton). Only start polling if GITHUB_TOKEN is
      available. Add polling status to server health/debug info.
  - title: Add tests for polling service
    done: false
    description: Test polling loop timing and interval logic. Test rate limit budget
      calculations. Test exponential backoff behavior. Test SSE event emission
      on status changes. Test deduplication of PR URLs across plans. Test
      graceful shutdown. Test GITHUB_TOKEN missing behavior.
tags: []
---

Automatic background polling for PR check status on active plans, with SSE push updates to the web UI.

Key deliverables:
- Background polling service in web server (src/lib/server/pr_polling.ts)
- Uses lightweight fetchPrCheckStatus() query for frequent polling
- Polls only for plans in active states (in_progress, needs_review) with linked PRs
- Deduplicate PR URLs across plans
- SSE event: pr:status-update pushed to connected browsers when status changes
- Client store handles pr:status-update events to reactively update UI
- Configurable polling interval (default 5 minutes)
- GitHub API rate limit management with request budgeting
- Graceful degradation when GITHUB_TOKEN unavailable
- Exponential backoff on errors
