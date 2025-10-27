---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add multi-user assignment support with environment variable and shared config
goal: Enable multi-user workflows in rmplan by supporting user identity via
  environment variables and tracking assignments in a shared configuration
id: 139
generatedBy: agent
status: pending
priority: high
temp: false
planGeneratedAt: 2025-10-27T05:51:38.824Z
promptsGeneratedAt: 2025-10-27T05:51:38.824Z
createdAt: 2025-10-27T05:51:22.359Z
updatedAt: 2025-10-27T05:51:38.824Z
tasks:
  - title: Add environment variable support for current user identity
    done: false
    description: Allow using an environment variable (e.g., RMPLAN_USER) to specify
      who the current user is. This will be used for filtering tasks and
      tracking assignments. Add configuration option and validation for the user
      identity.
    steps: []
  - title: Add internal UUID to plan schema
    done: false
    description: Add an internal UUID field to the plan schema that survives
      renumbering operations. This UUID will be used as the stable key for
      tracking assignments across different repositories and plan renumbering.
      Generate UUID on plan creation and preserve it through all operations.
    steps: []
  - title: Implement shared config directory for assignment tracking
    done: false
    description: Create a shared config directory (e.g., ~/.config/rmplan or
      ~/.rmplan) to track plan assignments. Store assignments keyed by the
      internal UUID. Use the git origin URL to resolve and identify the same
      repository across different local paths. Implement functions to read/write
      assignment data.
    steps: []
  - title: Update ready command to filter by current user
    done: false
    description: Modify the ready command to by default only show tasks that are
      either unassigned or assigned to the current user (as specified by the
      environment variable). Add a flag to override this behavior and show all
      ready tasks regardless of assignment.
    steps: []
---
