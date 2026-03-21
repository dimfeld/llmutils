---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Review Comment Actions
goal: ""
id: 251
uuid: 9222b252-c090-4212-bcf3-2e5c050dd167
generatedBy: agent
status: pending
priority: medium
dependencies:
  - 250
parent: 245
references:
  "245": 50487743-93a6-45c0-bda9-ce9e19100c92
  "250": cb016b34-853c-4efa-893f-221d812b45e8
planGeneratedAt: 2026-03-21T02:29:39.558Z
promptsGeneratedAt: 2026-03-21T02:29:39.558Z
createdAt: 2026-03-21T02:25:16.065Z
updatedAt: 2026-03-21T02:29:39.559Z
tasks:
  - title: Add review comment to plan task conversion
    done: false
    description: "Create utility function to convert a review comment/thread into a
      plan task: title from file path + line summary, description from comment
      body + diff context. Web UI action button on each review thread to add as
      task. Uses existing upsertPlanTasks or addPlanTask from plan.ts. Updates
      plan file via writePlanFile after adding task. API endpoint for this
      action."
  - title: Build web UI for selecting and adding comments as tasks
    done: false
    description: Add checkboxes to review threads in PrReviewThreads.svelte for
      multi-select. Add as Tasks button that converts selected threads to tasks.
      Show confirmation with preview of task titles/descriptions. After adding,
      mark threads as addressed in local state (visual indicator). Sync
      addressed state if desired.
  - title: Implement automatic fix workflow for review comments
    done: false
    description: "Create executor integration to generate fixes for selected review
      comments. Build prompt with: review comment body, diff context, file
      content, plan context. Use existing executor system
      (claude_code/codex_cli) via the agent runner pattern. After fix is
      applied, optionally post reply to review thread via existing
      addReplyToReviewThread() GraphQL mutation."
  - title: Add CLI tim pr fix command
    done: false
    description: Add prCommand.command(fix [planId]) to tim pr namespace. Fetches
      review comments for linked PRs. Interactive selection of comments to fix
      (using existing selectReviewComments pattern from pull_requests.ts or
      similar). Runs executor to generate fixes. Posts replies to resolved
      threads. Updates plan task status.
  - title: Add tests for review comment actions
    done: false
    description: Test comment-to-task conversion logic. Test the fix workflow prompt
      building. Test reply posting after fix. Test CLI pr fix command flow. Test
      web UI action endpoint.
tags: []
---

Add review comments as tasks to plans and trigger automatic fixes via the executor system.

Key deliverables:
- Web UI action: select review comments and add them as tasks to the plan
- Convert review comment to task: title from file+line summary, description from comment body + diff context
- Web UI action: trigger automatic fix for selected review comments
- Integrate with executor system (claude_code / codex_cli) to generate fixes
- Post reply to review thread after fix is applied (using existing addReplyToReviewThread)
- Mark resolved review threads in the cached data
- CLI equivalent: tim pr fix [planId] to fix review comments from terminal
