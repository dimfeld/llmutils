---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: DB-first plan storage
goal: ""
id: 278
uuid: 8c8ba325-58ad-4033-b45a-a9a1efd654a6
status: pending
priority: high
epic: true
dependencies:
  - 279
  - 280
  - 281
  - 282
references:
  "279": 9912c78d-87f8-4e88-987a-2b577ac925a6
  "280": 6de3727b-1e50-4cee-80ea-786d92db3a6c
  "281": 27796c49-6f51-4d41-83c9-1ad8db6c67d2
  "282": f299ed01-b2d9-4cd3-82fb-622229d5c4d2
createdAt: 2026-03-25T03:46:29.544Z
updatedAt: 2026-03-25T03:50:59.103Z
tasks: []
tags:
  - architecture
  - epic
---

<!-- tim-generated-start -->
## Overview

This epic inverts the plan storage architecture from file-first to DB-first. Currently, plan files on disk are the source of truth and the SQLite database is a read-only cache synchronized via `plan_sync.ts`. This creates problems for workflows where the git repository branch state doesn't match what you want to edit (e.g., web UI editing, importing issues in repos where you can't push to main).

## New Architecture

- **Database is source of truth** for all plan data
- **Plan files are materialized working copies** written to `~/.cache/tim/plans/{uuid}.plan.md` or into workspaces on demand
- **Bidirectional sync**: materialize (DB → file) and sync (file → DB) with mtime-based change detection
- **Auto-sync wrapper**: tim commands that modify plans check for materialized file changes before applying their updates, then re-materialize

## Key Design Decisions

- The `details` column in the plan table already stores the markdown body — no new schema needed for content storage
- Plans no longer require a tasks directory or file path to exist
- `tim add` creates in DB only; materialization is separate
- Agents get plans materialized into their workspace on start, synced back on shutdown
- Web UI edits DB directly

## Child Plans

1. **279**: Core materialization/sync infrastructure
2. **280**: Convert all tim commands to DB-first access
3. **281**: Agent workspace materialization integration
4. **282**: Deprecate tasks directory and file-scanning code
<!-- tim-generated-end -->
