---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Plan materialization and sync infrastructure
goal: Create the core infrastructure for materializing plan files from the
  database to disk and syncing changes back. This inverts the current
  architecture where files are source of truth and DB is a read cache.
id: 279
uuid: 9912c78d-87f8-4e88-987a-2b577ac925a6
generatedBy: agent
status: pending
priority: high
parent: 278
references:
  "278": 8c8ba325-58ad-4033-b45a-a9a1efd654a6
planGeneratedAt: 2026-03-25T03:48:08.193Z
promptsGeneratedAt: 2026-03-25T03:48:08.193Z
createdAt: 2026-03-25T03:46:35.033Z
updatedAt: 2026-03-25T03:50:43.069Z
tasks:
  - title: Verify DB schema covers full plan reconstruction
    done: false
    description: Verify that the existing DB schema (title, goal, details, tasks,
      status, priority, tags, dependencies, etc.) is sufficient to fully
      reconstruct a plan file from DB data alone. The `details` column stores
      the markdown body. Identify any fields present in plan files but missing
      from the DB and add them if needed. No new content column is required.
  - title: Implement materializePlan() function
    done: false
    description: "Create a function that takes a plan ID/UUID and an optional target
      path, reads the plan from the DB, and writes it as a properly-formatted
      plan file (YAML frontmatter + markdown body). Default path should be
      `~/.cache/tim/plans/{planUuid}.plan.md` (using getTimCacheDir()). Track
      the materialization: store the target path and the mtime of the written
      file so we can detect external edits later. Return the path where the file
      was written."
  - title: Implement syncMaterializedPlan() function
    done: false
    description: Create a function that reads a materialized plan file from disk,
      parses it, and updates the DB with any changes. Should check mtime against
      last-known write to detect if the file was modified externally (by an
      agent or editor). This is essentially the reverse of the current
      syncPlanToDb() flow. Should handle the case where the file hasn't changed
      (no-op).
  - title: Implement auto-sync wrapper for tim commands
    done: false
    description: "Create a wrapper/helper that tim commands can use when modifying a
      plan: (1) if a materialized file exists and has been modified since last
      materialization, sync file -> DB first, (2) perform the DB modification,
      (3) re-materialize the file. This ensures agents editing the file and
      running tim commands don't lose each other's changes."
  - title: Add tim materialize and tim sync CLI commands
    done: false
    description: "Add explicit CLI commands: `tim materialize <planId> [--path
      <path>]` to materialize a plan to disk, and `tim sync <planId|path>` to
      sync a materialized file back to DB. These are for manual/scripted use.
      The materialize command should print the path to stdout for easy piping."
  - title: Add cleanup for stale materialized files
    done: false
    description: Implement cleanup logic for materialized files in the cache
      directory. Could be time-based (remove files older than N days) or
      triggered explicitly. Register cleanup in the existing cleanup registry
      pattern.
  - title: Write tests for materialize/sync round-trip
    done: false
    description: Test that materialize -> edit -> sync -> materialize produces
      correct results. Test mtime detection, no-op sync when unchanged, conflict
      detection, and the auto-sync wrapper behavior.
tags:
  - architecture
---
