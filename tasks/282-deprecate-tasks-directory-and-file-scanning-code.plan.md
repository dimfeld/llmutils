---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Deprecate tasks directory and file-scanning code paths
goal: Remove the tasks directory as a concept, eliminate file-scanning code
  paths, and clean up configuration that references task directories.
id: 282
uuid: f299ed01-b2d9-4cd3-82fb-622229d5c4d2
generatedBy: agent
status: pending
priority: medium
dependencies:
  - 281
parent: 278
references:
  "278": 8c8ba325-58ad-4033-b45a-a9a1efd654a6
  "281": 27796c49-6f51-4d41-83c9-1ad8db6c67d2
planGeneratedAt: 2026-03-25T03:50:25.783Z
promptsGeneratedAt: 2026-03-25T03:50:25.783Z
createdAt: 2026-03-25T03:46:36.964Z
updatedAt: 2026-03-25T03:50:25.783Z
tasks:
  - title: Remove resolveTasksDir() and tasks directory config
    done: false
    description: Remove the resolveTasksDir() function from path_resolver.ts and the
      paths.tasks config option from configSchema.ts. All plan access now goes
      through the DB.
  - title: Remove file-scanning from syncAllPlansToDb
    done: false
    description: The syncAllPlansToDb function scans a directory with glob patterns
      to find plan files. This is no longer needed since DB is source of truth.
      Either remove the function entirely or repurpose it as a one-time import
      tool.
  - title: Remove file-scanning fallbacks from list/display commands
    done: false
    description: Commands like list, ready, and plan_display.ts have fallback paths
      that scan files when DB queries don't return results. Remove these
      fallbacks - DB is now authoritative.
  - title: Clean up plan file I/O functions
    done: false
    description: Review plans.ts and remove or simplify functions that are no longer
      needed now that DB is source of truth. readPlanFile() may still be needed
      for the sync path (reading materialized files), but scanForPlans(),
      loadPlans(), and similar directory-scanning functions can be removed.
  - title: Update documentation and CLAUDE.md
    done: false
    description: Update CLAUDE.md, README, and any other docs to reflect the new
      DB-first architecture. Remove references to tasks directories and plan
      file locations.
tags:
  - architecture
---
