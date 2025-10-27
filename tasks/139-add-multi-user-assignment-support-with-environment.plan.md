---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add multi-user assignment and status tracking with shared config
goal: Enable multi-user workflows in rmplan by supporting user identity via
  environment variables and tracking both plan assignments and status in a
  shared configuration
id: 139
generatedBy: agent
status: pending
priority: high
temp: false
planGeneratedAt: 2025-10-27T07:32:41.570Z
promptsGeneratedAt: 2025-10-27T07:32:41.570Z
createdAt: 2025-10-27T05:51:22.359Z
updatedAt: 2025-10-27T07:32:41.570Z
tasks:
  - title: Add environment variable support for current user identity
    done: false
    description: Add support for a `RMPLAN_USER` environment variable that
      identifies the current user in multi-user workflows. This will be used to
      filter plans and track assignments.
    steps: []
  - title: Add internal UUID to plan schema
    done: false
    description: Add a unique UUID field to the plan schema that can be used to
      track plans across different users and systems, independent of the plan ID
      or file path.
    steps: []
  - title: Implement shared config directory for assignment and status tracking
    done: false
    description: "Create a shared configuration directory (e.g., `.rmplan/shared/`)
      that tracks both plan assignments (which user is working on which plan)
      and plan status (pending, in_progress, done, blocked, etc.). This allows
      multiple users to coordinate their work without conflicting changes to the
      plan files themselves. The shared file should store: plan UUID, assigned
      user, current status, and last updated timestamp."
    steps: []
  - title: Update ready command to filter by current user and respect shared status
    done: false
    description: >-
      Modify the `rmplan ready` command to:

      1. Filter plans to show only those assigned to the current user (from
      RMPLAN_USER environment variable)

      2. Respect the status tracked in the shared config file as the source of
      truth

      3. Fall back to plan file status when no shared status exists

      4. Optionally show all unassigned plans with a flag
    steps: []
---
