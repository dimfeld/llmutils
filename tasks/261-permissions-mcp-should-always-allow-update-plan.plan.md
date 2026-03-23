---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: permissions mcp should always allow update-plan-tasks commands
goal: ""
id: 261
uuid: 5d32c3c2-3400-4157-8218-646f0a101ec7
status: done
priority: medium
createdAt: 2026-03-23T19:36:32.913Z
updatedAt: 2026-03-23T19:36:32.914Z
tasks: []
tags: []
---

When a bash command ends in `tim tools update-plan-tasks`, it should be autoapproved.

## Current Progress
### Current State
- Implementation complete and tested
### Completed (So Far)
- Added `Bash(tim tools update-plan-tasks:*)` to default allowed tools in `run_claude_subprocess.ts`
- Modified Bash prefix matching in `permissions_mcp_setup.ts` to also try matching after stripping `cd <dir> &&` prefixes using `extractCommandAfterCd`
- Added tests for both the new default tool entry and the cd-prefix stripping behavior
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Used `extractCommandAfterCd` from `prefix_prompt_utils.ts` for cd-prefix stripping rather than custom regex, reusing existing utility
- The cd-prefix stripping applies to all Bash prefix matching, not just `update-plan-tasks`, which is a general improvement
### Lessons Learned
- None
### Risks / Blockers
- None
