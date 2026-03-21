---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: PR Review Comments in Web UI
goal: ""
id: 250
uuid: cb016b34-853c-4efa-893f-221d812b45e8
generatedBy: agent
status: pending
priority: medium
dependencies:
  - 248
parent: 245
references:
  "245": 50487743-93a6-45c0-bda9-ce9e19100c92
  "248": f92da2f3-c73f-4b89-83c8-03b509d58d1d
planGeneratedAt: 2026-03-21T02:29:28.079Z
promptsGeneratedAt: 2026-03-21T02:29:28.079Z
createdAt: 2026-03-21T02:25:08.526Z
updatedAt: 2026-03-21T02:29:28.080Z
tasks:
  - title: Extend GitHub API to fetch review threads
    done: false
    description: "Add fetchPrReviewThreads() query to src/common/github/pr_status.ts
      (or extend fetchPrFullStatus). Fetch review threads with full context:
      file path, line number, diff hunk, comment body, author, resolved/outdated
      status, thread ID. Define TypeScript types for review thread data. Handle
      pagination for PRs with many threads. Can leverage parts of existing
      fetchPullRequestAndComments() GraphQL query from pull_requests.ts."
  - title: Add database tables for review thread caching
    done: false
    description: "Add migration creating pr_review_thread and pr_review_comment
      tables. pr_review_thread: pr_status_id FK, thread_id, file_path, line,
      original_line, is_resolved, is_outdated, diff_side. pr_review_comment:
      thread_id FK, comment_id, author, body, diff_hunk, created_at. CRUD
      functions in src/tim/db/pr_status.ts for upserting and querying
      threads/comments."
  - title: Include review threads in PlanDetail data loading
    done: false
    description: Extend PrStatusDetail type to include review threads. Update
      getPlanDetail() in db_queries.ts to load review threads + comments from
      DB. Add review thread data to the pr-status API endpoint response. Include
      thread count summary (unresolved/total) in the PrStatusDetail for quick
      display.
  - title: Build review threads UI in PlanDetail
    done: false
    description: "Create PrReviewThreads.svelte component showing review threads
      grouped by file path. Each thread shows: file path + line number, comment
      body (rendered), resolved/outdated badges, diff context snippet, all
      comments in thread. Collapsible thread view for plans with many comments.
      Filter toggle: show all / unresolved only. Add to PrStatusSection.svelte
      below checks and reviews."
  - title: Add tests for review thread fetching and display
    done: false
    description: Test GraphQL query for review threads with mock responses. Test DB
      CRUD for review thread tables. Test review thread data flows through to
      PlanDetail. Test filter toggle (all vs unresolved) logic.
tags: []
---

Surface individual PR review comment threads on the plan detail page in the web UI.

Key deliverables:
- Extend fetchPrFullStatus() or add separate query to fetch review threads with full context (file, line, diff hunk, comment body, author, resolved/unresolved status)
- DB table for cached review threads and comments (or extend pr_review table)
- New PlanDetail section showing review threads grouped by file
- Each thread shows: file path + line, comment body, resolved/outdated status, diff context
- Collapsible thread view for plans with many comments
- Filter: show all / unresolved only
- Refresh review data as part of the stale-while-revalidate pattern from plan 248
