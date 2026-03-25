---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Convert tim commands to DB-first plan access
goal: Update all tim CLI commands and MCP tools to read/write plan data from the
  DB as source of truth, using the materialization infrastructure from plan 279.
id: 280
uuid: 6de3727b-1e50-4cee-80ea-786d92db3a6c
generatedBy: agent
status: pending
priority: high
dependencies:
  - 279
parent: 278
references:
  "278": 8c8ba325-58ad-4033-b45a-a9a1efd654a6
  "279": 9912c78d-87f8-4e88-987a-2b577ac925a6
planGeneratedAt: 2026-03-25T03:49:45.320Z
promptsGeneratedAt: 2026-03-25T03:49:45.320Z
createdAt: 2026-03-25T03:46:35.916Z
updatedAt: 2026-03-25T03:49:45.321Z
tasks:
  - title: Update resolvePlan() to load from DB instead of file scanning
    done: false
    description: Currently resolvePlan() scans the tasks directory for plan files.
      Change it to query the DB by plan ID, UUID, or title search. The function
      should return plan data from the DB along with the materialized file path
      (if one exists). This is the central change that most commands depend on.
  - title: Update writePlanFile() to write DB first, then materialize
    done: false
    description: "Invert the current flow: instead of writing the file and then
      syncing to DB, write to DB first and then materialize the file if one
      exists. This ensures DB is always up-to-date even if file write fails.
      Keep the function signature compatible so callers don't all need to change
      at once."
  - title: Update tim tools commands to use DB-first pattern
    done: false
    description: "Update update-plan-tasks, manage-plan-task, update-plan-details,
      get-plan, and create-plan to use the auto-sync wrapper from plan 279. They
      should: sync any existing materialized file -> DB, modify DB,
      re-materialize. This replaces the current read-file/modify/write-file
      pattern."
  - title: Update tim set command for DB-first
    done: false
    description: The set command modifies plan metadata (status, priority,
      dependencies, tags, etc.). Update it to modify the DB directly and
      re-materialize if needed, instead of reading/writing plan files.
  - title: Update tim add / create-plan to write DB only
    done: false
    description: New plans should be created in the DB without requiring a tasks
      directory or file. The file path in DB can be null/empty for plans that
      haven't been materialized yet. Print the plan ID and optionally
      materialize if --edit flag is used.
  - title: Update tim edit to use materialize/edit/sync cycle
    done: false
    description: "The edit command should: materialize the plan to a temp or cache
      path, open $EDITOR, then sync the result back to DB on editor close. This
      replaces direct file editing."
  - title: Update plan list/display commands to use DB
    done: false
    description: Update tim list, tim next, tim ready, and plan_display.ts to query
      from DB instead of scanning files. Most of these already have DB paths
      (loadPlansFromDb) - make DB the primary path and remove file-scanning
      fallbacks.
  - title: Update done/set-task-done commands for DB-first
    done: false
    description: These commands mark tasks/plans as done. Update to modify DB
      directly, using the auto-sync wrapper to handle any existing materialized
      files.
tags:
  - architecture
---
