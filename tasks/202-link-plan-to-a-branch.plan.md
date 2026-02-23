---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: link plan to a branch
goal: ""
id: 202
uuid: d9953b72-c29f-4c67-a6dc-4ba86692692f
status: done
priority: medium
createdAt: 2026-02-21T21:41:54.726Z
updatedAt: 2026-02-23T05:36:27.840Z
tasks:
  - title: Add `branch` field to plan schema and SQLite
    done: true
    description: >
      Add a `branch: z.string().optional()` field to the phaseSchema in
      planSchema.ts (near baseBranch). Add a migration v4 in db/migrations.ts:
      `ALTER TABLE plan ADD COLUMN branch TEXT`. Update PlanRow and
      UpsertPlanInput interfaces in db/plan.ts to include `branch`. Update the
      upsertPlan SQL INSERT/ON CONFLICT to include the branch column. Update
      toPlanUpsertInput in db/plan_sync.ts to pass plan.branch through.
  - title: Set branch in generate and agent commands after execution
    done: true
    description: >
      In both the generate command (src/tim/commands/generate.ts) and agent
      command (src/tim/commands/agent/agent.ts), after execution completes,
      detect the current branch using getCurrentBranchName() and
      getTrunkBranch() from src/common/git.ts. If the current branch is not a
      trunk branch (main/master/trunk/default), set plan.branch to the current
      branch name before calling writePlanFile. Always overwrite the existing
      branch value since we want the latest.
  - title: Add tests for branch linking
    done: true
    description: >
      Write tests verifying: (1) the branch field round-trips through
      writePlanFile/readPlanFile, (2) the branch field is stored and retrieved
      from SQLite via upsertPlan/getPlanByUuid, (3) branch is set correctly when
      not on a trunk branch (integration or unit test as appropriate).
tags: []
---

We should be able to link a plan to the latest branch on which work was done for it. Add a new `branch` field to the plan
schema and in the sqlite tasks schema as well.

When running `generate` or `agent` commands, if we are not on a trunk branch then set `branch` to the current branch name.

If `branch` is already set, then we should overwrite it since we always want the latest value.

## Current Progress
### Current State
- All three tasks are complete. Implementation is verified with passing type checks and tests.
### Completed (So Far)
- Added `branch` optional string field to plan schema in planSchema.ts
- Added SQLite migration v4: `ALTER TABLE plan ADD COLUMN branch TEXT`
- Updated PlanRow, UpsertPlanInput, and upsertPlan() in db/plan.ts
- Updated toPlanUpsertInput in db/plan_sync.ts to pass branch through
- Regenerated schema/tim-plan-schema.json to include branch field
- Added branch detection in generate.ts after executor completion (with try/catch, avoids redundant syncs)
- Added branch detection in agent.ts both in the main loop and via an `updatePlanBranchMetadata` helper
- Added tests for plan file round-trip, DB upsert/clear, and plan_sync persistence
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Branch is only set when current branch differs from trunk (main/master/trunk/default). When on trunk, the previous branch value is preserved rather than cleared.
- In agent.ts, branch detection uses a dedicated helper function `updatePlanBranchMetadata` and also updates inline during the task loop to keep metadata current.
### Lessons Learned
- None
### Risks / Blockers
- None
