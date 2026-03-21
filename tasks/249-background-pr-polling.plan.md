---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Background PR Polling
goal: ""
id: 249
uuid: 8c93ae87-992a-440a-bfaf-93898d93d21b
status: pending
priority: medium
dependencies:
  - 248
parent: 245
references:
  "245": 50487743-93a6-45c0-bda9-ce9e19100c92
  "248": f92da2f3-c73f-4b89-83c8-03b509d58d1d
createdAt: 2026-03-21T02:25:00.027Z
updatedAt: 2026-03-21T02:25:00.038Z
tasks: []
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
