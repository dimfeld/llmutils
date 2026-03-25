---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Agent workspace materialization integration
goal: Update the agent command and workspace setup to materialize plans from DB
  on start and sync back on completion, replacing the current file-copy
  approach.
id: 281
uuid: 27796c49-6f51-4d41-83c9-1ad8db6c67d2
generatedBy: agent
status: pending
priority: high
dependencies:
  - 280
parent: 278
references:
  "278": 8c8ba325-58ad-4033-b45a-a9a1efd654a6
  "280": 6de3727b-1e50-4cee-80ea-786d92db3a6c
planGeneratedAt: 2026-03-25T03:50:23.309Z
promptsGeneratedAt: 2026-03-25T03:50:23.309Z
createdAt: 2026-03-25T03:46:36.375Z
updatedAt: 2026-03-25T03:50:23.309Z
tasks:
  - title: Update workspace_setup.ts to materialize from DB
    done: false
    description: Instead of copying a plan file from one location to another, use
      materializePlan() to write the plan from DB into the workspace. The
      materialized path should be the same relative location the agent expects.
      Handle the case where a workspace already has a materialized file (sync it
      back to DB first before re-materializing).
  - title: Add final sync on agent shutdown
    done: false
    description: In the agent command's finally block / lifecycle shutdown, sync the
      materialized plan file back to DB one final time. This ensures any agent
      edits to the plan file (progress notes, etc.) are persisted. Use the
      existing cleanup registry or shutdown hooks.
  - title: Handle agent plan edits during execution
    done: false
    description: "During agent execution, the agent may both edit the plan file
      directly AND run tim commands that modify the plan. The auto-sync wrapper
      from plan 279 should handle this, but verify the flow works end-to-end:
      agent edits file -> tim set-task-done -> file synced to DB -> task marked
      done in DB -> file re-materialized with both changes."
  - title: Update headless adapter session info
    done: false
    description: Ensure the session info (sent to web UI via WebSocket) includes the
      plan's DB ID/UUID rather than relying on a file path. The web UI should be
      able to identify which plan an agent is working on from DB metadata.
  - title: Test agent workspace flow end-to-end
    done: false
    description: "Test the full cycle: plan created in DB -> agent starts -> plan
      materialized to workspace -> agent edits file -> agent runs tim commands
      -> agent shuts down -> plan synced back to DB with all changes preserved."
tags:
  - architecture
---
