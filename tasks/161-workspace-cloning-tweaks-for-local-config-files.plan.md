---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: workspace cloning tweaks for local config files
goal: ""
id: 161
uuid: f7d48064-cd2a-43b9-ae9e-8d9cb29054fe
simple: true
status: done
priority: medium
createdAt: 2026-01-05T01:47:12.909Z
updatedAt: 2026-01-05T02:39:51.250Z
tasks: []
tags: []
---

We copy some "local" settings files for rmplan when copying a workspace. Make these changes:

- Use symlinks instead of copying local config files
- Update workspace cloning methods that use work trees to also symlink the local configs in the new workspace

## Current Progress
### Current State
- Implementation complete and all tests passing

### Completed (So Far)
- Removed local config files (`.rmfilter/config/rmplan.local.yml`, `.claude/settings.local.json`) from regular file copying in `collectFilesToCopy()`
- Created `symlinkLocalConfigs()` function that creates symlinks for local config files from source to target directory
- Updated all three clone methods (`cloneWithGit`, `cloneWithCp`, `cloneWithMacCow`) to call `symlinkLocalConfigs()` after their main operations
- Updated tests to verify symlink behavior instead of copy behavior
- Fixed lint issues (floating promise and template literal type)
- All 2474 tests pass, type checking and linting pass

### Remaining
- None

### Next Iteration Guidance
- None

### Decisions / Changes
- Used absolute paths for symlink targets to ensure they work regardless of current working directory
- Symlinks are created after the main clone operation in all methods
- Missing source files are silently skipped (existing graceful handling preserved)
- Errors during symlink creation are logged but don't fail the overall operation

### Risks / Blockers
- None
