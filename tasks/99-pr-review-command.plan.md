---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: PR review command
goal: Implement a new `rmplan review` command that analyzes code changes on the
  current branch against trunk, evaluates compliance with plan requirements, and
  provides comprehensive code quality feedback using the reviewer agent.
id: 99
uuid: b9ee92f5-e5b6-4035-9125-166c3b438180
status: done
priority: medium
container: true
dependencies:
  - 100
  - 101
  - 102
createdAt: 2025-08-13T20:28:04.715Z
updatedAt: 2025-10-27T08:39:04.238Z
tasks: []
---

# Original Plan Details

Add a new review command to `rmplan`, which can look at the current branch, compare it to the trunk branch to see what has changed, and run the executor with a prompt based on the reviewer agent, which will do an extensive review of the code, both for general quality and for compliance to the requirements of the plan.

If the plan given on the command line is a parent to other plans, then the parent and all of its done children should be included in the review. Also allow specifying more than one plan to review at the same time.

If the plan passed has a parent, the parent information should be included in the review instructions as well, with the
idea that it is there to give additional context to the review.

# Processed Plan Details

## Add PR review command to rmplan for comprehensive code review against plan requirements

The review command will compare the current branch to the trunk branch, gather all relevant plan context (including parent and completed children), and execute a thorough code review using the existing reviewer agent prompt. The command should support reviewing multiple plans simultaneously, handle parent-child relationships intelligently, and integrate seamlessly with the existing executor system. The review should focus on both general code quality (bugs, security, performance) and specific compliance with the plan's requirements and goals.

Acceptance criteria:
- Command can review single or multiple plans
- Automatically includes parent context when reviewing child plans
- Includes completed children when reviewing parent plans
- Generates comprehensive diff against trunk branch
- Works with both Git and jj version control systems
- Supports all existing executors (Claude Code, copy-paste, etc.)
- Provides clear feedback on code quality and requirement compliance
