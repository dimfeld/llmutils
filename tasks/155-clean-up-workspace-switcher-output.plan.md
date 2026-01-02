---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: clean up workspace switcher output
goal: ""
id: 155
uuid: bb7204f0-bb70-4856-bb41-20f639432125
simple: true
status: done
priority: medium
createdAt: 2026-01-02T01:07:14.306Z
updatedAt: 2026-01-02T01:22:09.288Z
tasks: []
tags: []
---

Right now it does this TSV output but that doesn't look great. Instead lets do the full directory, a tab, and then a
nicely formatted name/description/branch/etc with deduplication of identical values.

## Current Progress
### Current State
- Implementation complete and verified

### Completed (So Far)
- Modified `outputWorkspaceTsv()` in `workspace.ts` to output 2-column format: `fullPath\tformattedDescription`
- Added new `formatWorkspaceDescription()` function for nicely formatted, human-readable output
- Implemented deduplication logic (case-insensitive) so identical values don't repeat
- Updated shell-integration fzf arguments to work with new 2-column format
- Simplified fzf preview to just show path since description is already visible
- Updated all tests in workspace.list.test.ts for new format
- Added unit tests for formatWorkspaceDescription covering all deduplication cases
- Updated shell-integration.test.ts for new preview format
- All 2394 tests pass

### Remaining
- None

### Next Iteration Guidance
- None - implementation complete

### Decisions / Changes
- Changed from 8-column TSV to 2-column format for better readability
- Second column uses `|` separator between parts (basename, name, description, branch, issue refs)
- Branch displayed in brackets `[branch]`
- Issue URLs converted to references like `#123` or `PROJ-456`
- Removed header output since column names not needed with just 2 columns

### Risks / Blockers
- None
