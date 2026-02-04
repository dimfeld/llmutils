---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Migrate tim storage from JSON files to SQLite database
goal: ""
id: 158
uuid: e17331a4-1827-49ea-88e6-82de91f993df
status: pending
priority: medium
createdAt: 2026-01-02T17:08:05.033Z
updatedAt: 2026-01-02T17:08:05.033Z
tasks: []
tags: []
---

## Overview

Migrate all tim functionality that tracks state via JSON files in `.config/tim` to use an SQLite database instead. The data model should be relational (normalized), replacing the current denormalized JSON structure.

## Current JSON Storage

Files being replaced:
- `~/.config/tim/shared/{repositoryId}/assignments.json` - Plan claims/assignments
- `~/.config/tim/shared/{repositoryId}/permissions.json` - Claude Code approval permissions
- `~/.config/tim/workspaces.json` - Global workspace tracking
- `~/.config/tim/repositories/{repoName}/metadata.json` - External storage metadata

## Database Schema

### Tables

**project**
- id (PK, auto-increment)
- repository_id (unique) - stable identifier string
- remote_url (nullable)
- last_git_root
- external_config_path
- external_tasks_dir
- remote_label
- highest_plan_id - atomic counter for plan ID generation
- created_at
- updated_at

**workspace**
- id (PK, auto-increment)
- project_id (FK to project, required)
- task_id
- workspace_path (unique)
- original_plan_file_path
- branch
- name
- description
- plan_id
- plan_title
- created_at
- updated_at

**workspace_issue**
- id (PK)
- workspace_id (FK to workspace)
- issue_url

**workspace_lock**
- workspace_id (FK to workspace, unique)
- lock_type ('file' | 'pid' | 'advisory')
- pid
- started_at
- hostname
- command

**permission**
- id (PK)
- project_id (FK to project)
- permission_type ('allow' | 'deny')
- pattern

**assignment**
- id (PK)
- project_id (FK to project)
- plan_uuid (unique per project)
- plan_id
- workspace_id (FK to workspace, nullable) - local claim
- claimed_by_user - who claimed (supports remote sync scenarios)
- status
- assigned_at
- updated_at

### Indices

- project(repository_id) - unique
- workspace(workspace_path) - unique
- workspace(project_id)
- assignment(project_id, plan_uuid) - unique
- assignment(workspace_id)
- permission(project_id)

## SQLite Configuration (bun:sqlite)

```typescript
db.exec("PRAGMA journal_mode = WAL");      // Write-ahead logging
db.exec("PRAGMA foreign_keys = ON");       // Enforce FK constraints
db.exec("PRAGMA busy_timeout = 5000");     // 5s timeout for locks
db.exec("PRAGMA synchronous = NORMAL");    // Good perf with WAL
```

For write transactions, use `BEGIN IMMEDIATE` to acquire write lock upfront and avoid deadlocks.

## Design Decisions

| Decision | Choice |
|----------|--------|
| Concurrency control | Transactions (BEGIN IMMEDIATE), no version columns |
| Migration strategy | Single initial schema, import existing JSON on first run |
| Stale lock cleanup | On read (5-min threshold like current) |
| Workspace without project | Always require project; create one if needed |
| Historical tracking | Current state only |
| Multiple workspaces per assignment | No - one workspace per assignment |
| User tracking | `claimed_by_user` on assignment (supports remote sync) |
| Released assignments | Delete the record |

We must make sure that any migration SQL is readable by the built script in dist as well, whether that's by copying the
SQL as part of the build script or some other way.

## Database Location

Store the SQLite database at `~/.config/tim/tim.db` (or platform equivalent).
