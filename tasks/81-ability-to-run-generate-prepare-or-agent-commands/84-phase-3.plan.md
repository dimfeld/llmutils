---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Ability to run, generate, prepare, or agent commands on the next ready
  dependency of a plan. - Final Polish and Documentation
goal: To enhance the user experience with improved error handling and to provide
  clear documentation for the new feature.
id: 84
status: pending
priority: medium
dependencies:
  - 83
parent: 81
planGeneratedAt: 2025-07-29T23:21:36.332Z
createdAt: 2025-07-29T19:19:03.441Z
updatedAt: 2025-07-29T23:21:36.332Z
tasks:
  - title: Enhance Error Handling and User Feedback
    description: Review all new code paths to ensure that potential failures are
      handled gracefully. Improve error messages to be more descriptive, guiding
      the user on what went wrong (e.g., "Parent plan not found," "No ready or
      pending dependencies found for plan X").
    steps: []
  - title: Add Logging for Dependency Selection
    description: Implement structured logging that, when enabled, details the
      dependency search process. This should include the parent plan, the
      dependencies that were scanned, their states, and which dependency was
      ultimately chosen.
    steps: []
  - title: Update Command-Line Help Text
    description: Modify the help documentation for the `generate`, `prepare`, and
      `agent` commands. The description for the new `--next-ready` flag
      should be clear, concise, and explain its purpose and behavior.
    steps: []
  - title: Update Project Documentation
    description: Update the `README.md` file or other relevant documentation to
      include a section describing the new feature. This section should explain
      the problem it solves and provide clear examples of how to use the
      `--next-ready` flag.
    steps: []
rmfilter:
  - src/rmplan
---

This final phase focuses on making the feature robust and easy to use. It involves refining error messages, adding logging for better visibility, and updating all user-facing documentation to explain the new capability.

### Acceptance Criteria
- Error messages are clear and helpful when a plan is not found or no ready dependency exists.
- Logging provides insight into which dependency was selected.
- The command-line `--help` text is updated for the modified commands.
- The project's `README.md` or other primary documentation includes a section on the new feature with usage examples.
