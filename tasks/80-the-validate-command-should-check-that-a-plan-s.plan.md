---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: The validate command should check that a plan's parent also depends on
  the child and automatically fix that if it doesn't.
goal: Add validation to ensure bidirectional parent-child relationships in plan
  files, where child plans with a parent field are automatically included in
  their parent's dependencies array, with automatic fixing of inconsistencies.
id: 80
uuid: 64642ea2-101e-48ce-a7bb-f69b8f961291
status: done
priority: medium
container: true
dependencies:
  - 96
  - 97
createdAt: 2025-07-29T19:17:43.223Z
updatedAt: 2025-10-27T08:39:04.278Z
tasks: []
---

## Implement parent-child dependency validation and auto-fix in rmplan validate command

The validate command should detect when a plan specifies a parent but that parent doesn't include the child in its dependencies array. This ensures consistency in the dependency graph and prevents orphaned child plans. The implementation should automatically fix these inconsistencies by updating parent plans, provide clear reporting of what was fixed, and maintain backward compatibility with existing validation functionality.

**Acceptance Criteria:**
- Validate command detects missing parent-child dependency relationships
- Automatic fixing updates parent plans to include child dependencies
- Clear reporting shows which relationships were fixed
- Existing validation functionality remains intact
- No circular dependencies are created
- Tests cover all edge cases including multiple children and nested hierarchies
