---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add discoveredFrom support to rmplan set command
goal: ""
id: 133
uuid: cf076ee0-2c50-48ce-a549-c267c7fe57fb
status: pending
priority: low
temp: false
dependencies:
  - 129
parent: 128
createdAt: 2025-10-26T22:41:16.609Z
updatedAt: 2025-10-27T08:39:04.279Z
tasks: []
---

## Overview

Extend the `rmplan set` command to support the new `discoveredFrom` field, allowing agents to mark plans with their discovery source.

## Changes Required

File: `src/rmplan/commands/set.ts`

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
rmplan set 42 --discovered-from 38

# Remove the discovery link
rmplan set 42 --no-discovered-from
```

## Testing

- Set discoveredFrom on a plan, verify with `rmplan show`
- Remove discoveredFrom, verify it's gone
- Try invalid values (negative, non-integer), expect errors
- Verify that `rmplan show` displays the "Discovered From" section correctly

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

This provides agents the same capability as `rmplan set --discovered-from`.
