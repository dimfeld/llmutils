---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Add discoveredFrom support to tim set command
goal: ""
id: 133
uuid: cf076ee0-2c50-48ce-a549-c267c7fe57fb
simple: true
status: done
priority: low
container: false
temp: false
dependencies:
  - 129
parent: 128
references:
  "128": f69d418b-aaf1-4c29-88a9-f557baf8f81e
  "129": 1993c51d-3c29-4f8d-9928-6fa7ebea414c
issue: []
pullRequest: []
docs: []
createdAt: 2025-10-26T22:41:16.609Z
updatedAt: 2025-10-29T07:27:55.596Z
progressNotes:
  - timestamp: 2025-10-29T07:19:31.845Z
    text: Successfully implemented --discovered-from and --no-discovered-from
      options in tim set command. Added CLI options in tim.ts with
      validation for positive integers, updated SetOptions interface, and added
      handler logic in set.ts that follows the same pattern as other options.
      Type checking and linting passed. Implementation verified via help text
      display.
    source: "implementer: discoveredFrom CLI support"
  - timestamp: 2025-10-29T07:25:28.237Z
    text: "Verified implementation is production-ready. All tests pass (2269 pass, 0
      fail). Fixed validation bug that allowed decimal values. Added
      comprehensive tests covering: setting discoveredFrom, removing
      discoveredFrom, handling missing fields, and changing values."
    source: "verifier: verify implementation"
  - timestamp: 2025-10-29T07:25:57.966Z
    text: All verification checks passed. Type checking, linting, and tests all
      successful. Verifier added comprehensive test coverage for the new
      discoveredFrom functionality and fixed a validation bug that allowed
      decimal values.
    source: "orchestrator: verification"
tasks: []
changedFiles: []
rmfilter: []
---

## Overview

Extend the `tim set` command to support the new `discoveredFrom` field, allowing agents to mark plans with their discovery source.

## Changes Required

File: `src/tim/commands/set.ts`

Add two new options:
```typescript
.option('--discovered-from <planId>', 'Set the plan this was discovered from', (value) => {
  const n = Number(value);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`discovered-from must be a positive integer, saw ${value}`);
  }
  return n;
})
.option('--no-discovered-from', 'Remove the discoveredFrom association')
```

In the handler function, add:
```typescript
if (options.discoveredFrom !== undefined) {
  updates.discoveredFrom = options.discoveredFrom;
} else if (options.noDiscoveredFrom) {
  updates.discoveredFrom = undefined;
}
```

## Example Usage

```bash
# Mark that plan 42 was discovered while working on plan 38
tim set 42 --discovered-from 38

# Remove the discovery link
tim set 42 --no-discovered-from
```

## Testing

- Set discoveredFrom on a plan, verify with `tim show`
- Remove discoveredFrom, verify it's gone
- Try invalid values (negative, non-integer), expect errors
- Verify that `tim show` displays the "Discovered From" section correctly

## Dependencies

Depends on plan 129 which adds the `discoveredFrom` schema field.

## MCP Integration

This will be covered by the comprehensive MCP tools plan (plan 138) which will add an `update-plan-properties` or `set-plan-fields` tool that can update any plan metadata field including `discoveredFrom`.

The tool would accept:
```typescript
{
  plan: string,
  discoveredFrom?: number | null,  // null to remove
  priority?: string,
  status?: string,
  // ... other fields
}
```

This provides agents the same capability as `tim set --discovered-from`.

# Implementation Notes

Successfully implemented discoveredFrom support for tim set command, allowing agents to mark plans with their discovery source. Modified src/tim/tim.ts to add --discovered-from and --no-discovered-from CLI options with validation for positive integers. Modified src/tim/commands/set.ts to handle setting and removing the discoveredFrom field, following the same pattern as other optional fields like parent. Added comprehensive test coverage in set.test.ts with 4 new tests covering setting, removing, and changing discoveredFrom values. Fixed validation bug during verification that allowed decimal values - added Number.isInteger check. All quality gates passed: type checking, linting, and 2269 tests all pass. Integration works seamlessly with plan schema from plan 129 and show command from plan 130.
