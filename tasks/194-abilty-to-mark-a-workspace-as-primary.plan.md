---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: abilty to mark a workspace as primary
goal: ""
id: 194
uuid: 2fe050da-fe45-44f3-8f82-920864918f31
simple: true
status: done
priority: medium
createdAt: 2026-02-14T08:06:09.359Z
updatedAt: 2026-02-14T08:17:24.749Z
tasks: []
tags: []
---

A primary workspace will never participate in the autoselection process, even if not locked.

## Current Progress
### Current State
- Feature fully implemented and verified. All feature-specific tests pass, type checking clean.
### Completed (So Far)
- Database migration v2 adding `is_primary` column to workspace table
- `isPrimary` field added to WorkspaceRow, WorkspaceInfo, WorkspaceMetadataPatch, PatchWorkspaceInput
- Primary workspaces excluded from autoselection (`selectWorkspace`), reuse (`tryReuseExistingWorkspace`), and `lock --available` (`lockAvailableWorkspace`)
- CLI flags `--primary` / `--no-primary` on `workspace update` command
- Primary status displayed in workspace list table (blue "Primary" label)
- Tests: autoselection skipping, update command primary toggling, schema version bump
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- `isPrimary` is only set to `true` in WorkspaceInfo (omitted/undefined when false) to keep JSON output clean
- Uses INTEGER 0/1 in SQLite (no native boolean), matching existing patterns
### Lessons Learned
- None
### Risks / Blockers
- None
