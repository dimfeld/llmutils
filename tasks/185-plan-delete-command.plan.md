---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: plan remove command
goal: ""
id: 185
uuid: 563d1d97-930a-4351-ade5-cba0be274a20
status: done
priority: medium
dependencies:
  - 184
references:
  "184": 05e31645-305d-4e59-8c49-a9fbc9ce0bd7
createdAt: 2026-02-13T08:39:40.395Z
updatedAt: 2026-02-13T21:28:27.841Z
tasks: []
tags: []
---

Currently we just delete not-needed plans manually, but with a command we can make sure that the SQLite database is kept up to date by removing it there as well.

The SQLite database is not supported yet but add a comment for it. Currently we will just `rm` the file.

## Current Progress
### Current State
- Implementation complete and verified
### Completed (So Far)
- Created `src/tim/commands/remove.ts` with full dependency cleanup (dependencies, parent, references)
- Registered `tim remove <planFiles...> [--force]` command in `src/tim/tim.ts`
- Created `src/tim/commands/remove.test.ts` with 8 tests covering happy path, force flag, multi-plan deletion, parent cleanup, and error cases
- Updated README with command documentation
- Added TODO comment for SQLite database cleanup when supported
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Command accepts variadic plan file arguments (IDs or paths)
- Without `--force`, removal is blocked if other plans depend on the target plan
- With `--force`, dependent plans are updated to remove references before deletion
- Assignment cleanup is best-effort (warns on failure)
### Lessons Learned
- The `cleanup-temp.ts` command provided a close pattern for file deletion, while `set.ts` showed how dependency/parent/reference relationships are managed
### Risks / Blockers
- None
