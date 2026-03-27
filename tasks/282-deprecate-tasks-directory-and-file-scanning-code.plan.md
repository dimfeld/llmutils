---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Deprecate tasks directory and file-scanning code paths
goal: Remove the tasks directory as a concept, eliminate file-scanning code
  paths, and clean up configuration that references task directories.
id: 282
uuid: f299ed01-b2d9-4cd3-82fb-622229d5c4d2
status: pending
priority: medium
parent: 278
createdAt: 2026-03-25T03:46:36.964Z
updatedAt: 2026-03-27T09:12:50.286Z
tasks: []
tags:
  - architecture
generatedBy: agent
references:
  "278": 8c8ba325-58ad-4033-b45a-a9a1efd654a6
---

## Planned Work

1. **Remove resolveTasksDir() and tasks directory config** — Remove the resolveTasksDir() function from path_resolver.ts and the paths.tasks config option from configSchema.ts. All plan access now goes through the DB.

2. **Remove file-scanning from syncAllPlansToDb** — The syncAllPlansToDb function scans a directory with glob patterns to find plan files. This is no longer needed since DB is source of truth. Either remove the function entirely or repurpose it as a one-time import tool.

3. **Remove file-scanning fallbacks from list/display commands** — Commands like list, ready, and plan_display.ts have fallback paths that scan files when DB queries don't return results. Remove these fallbacks — DB is now authoritative.

4. **Clean up plan file I/O functions** — Review plans.ts and remove or simplify functions that are no longer needed now that DB is source of truth. readPlanFile() may still be needed for the sync path (reading materialized files), but scanForPlans(), loadPlans(), and similar directory-scanning functions can be removed.

5. **Strip obsolete fields from plan files and schema** — Add stripping logic to `writePlanFile()` cleanup section (alongside existing `container`, `progressNotes` removal) for obsolete fields removed from `planSchema.ts` in plan 279: `generatedBy`, `rmfilter`, `promptsGeneratedAt`, `compactedAt`, `statusDescription`, `references`, `project`. Until this point, `.passthrough()` silently preserves these fields in existing files. This is the safe time to strip them since all plans are DB-first and no code depends on these fields.

6. **Update documentation and CLAUDE.md** — Update CLAUDE.md, README, and any other docs to reflect the new DB-first architecture. Remove references to tasks directories and plan file locations.

7. **Update the using-tim skill** — Update the tim skill references (adding-plans.md, generating-plans.md, viewing-and-completing.md, cli-commands.md) to reflect the new DB-first architecture, materialization commands (`tim materialize`, `tim sync`), `.tim/plans/` file locations, and removal of tasks directory concepts.
