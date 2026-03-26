---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: session detail plan info enhancements
goal: ""
id: 286
uuid: df991f45-81b0-4c56-8eb7-db9082097726
simple: true
status: done
priority: medium
createdAt: 2026-03-26T06:54:19.400Z
updatedAt: 2026-03-26T08:19:15.815Z
tasks:
  - title: "Address Review Feedback: API endpoint uses `+server.ts` instead of
      SvelteKit remote functions."
    done: true
    description: >-
      API endpoint uses `+server.ts` instead of SvelteKit remote functions. The
      project's custom review instructions explicitly state: "you should flag
      API +server.ts endpoints as anti-patterns, unless you need SSE event
      streaming. SvelteKit remote functions using `form`, `command`, and `query`
      are preferred otherwise." The existing codebase follows this pattern (see
      `src/lib/remote/pr_status.remote.ts` which uses `query` from
      `$app/server`). This endpoint is a simple GET query and should be a
      `query` remote function in a `.remote.ts` file.


      Suggestion: Convert to a `query` remote function in a file like
      `src/lib/remote/plan_task_counts.remote.ts`, following the pattern in
      `src/lib/remote/pr_status.remote.ts`. Then call it from the component
      using the generated client import.


      Related file: src/routes/api/plans/[planUuid]/task-counts/+server.ts:1-20
changedFiles:
  - src/lib/components/SessionDetail.svelte
  - src/lib/remote/plan_task_counts.remote.test.ts
  - src/lib/remote/plan_task_counts.remote.ts
  - src/routes/projects/[projectId]/sessions/[connectionId]/session_page.test.ts
tags: []
---

- Make the plan title into a link
- When the plan has tasks, show X/Y completed

## Current Progress
### Current State
- All tasks complete and verified
### Completed (So Far)
- Plan title in SessionDetail header is now a clickable link to `/projects/{projectId}/plans/{planUuid}`
- Task completion counts (X/Y) displayed next to plan info
- Converted task-counts endpoint from `+server.ts` API to SvelteKit `query` remote function (`src/lib/remote/plan_task_counts.remote.ts`)
- SessionDetail uses `$derived(await getPlanTaskCounts(...))` instead of manual fetch/AbortController
- Deleted old API endpoint and empty directory structure
- Tests added for the remote function (done/total counts, zero tasks, 404 for unknown plans)
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Used a Svelte snippet (`planText`) to avoid duplicating the plan ID + title markup between the link and plain-text fallback
- Task counts use SvelteKit remote function pattern for consistency with rest of codebase (e.g. `pr_status.remote.ts`)
### Lessons Learned
- The verifier created a test importing a non-existent `updatePlanTasksByUuid` function; the correct function is `upsertPlanTasks`. Always verify DB function names exist before using them in tests.
### Risks / Blockers
- None
