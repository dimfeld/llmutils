---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Enhance show command with full details and inverse relationships
goal: ""
id: 130
uuid: 44241afa-1440-4f8c-8ff5-c6276ed5ba78
status: pending
priority: medium
temp: false
dependencies:
  - 129
parent: 128
createdAt: 2025-10-26T22:41:03.601Z
updatedAt: 2025-10-27T08:39:04.218Z
tasks: []
---

## Overview

Enhance the `rmplan show` command to provide complete visibility into plan relationships. This makes it easier for autonomous agents to understand the full context of a plan, including what plans depend on it, what plans it spawned, and complete details without truncation.

## Problem

Currently `rmplan show` has two limitations:

1. **Truncation even with --full**: The details field is truncated at 20 lines even when using `--full` flag (see src/rmplan/commands/show.ts:280-295)
2. **One-way relationships only**: Shows forward relationships (dependencies, parent) but not inverse (blocked plans, children, discovered plans)

## Changes Required

File: `src/rmplan/commands/show.ts`

### 1. Fix --full Flag (lines 280-295)

**Current behavior:**
```typescript
if (plan.details) {
  log('\n' + chalk.bold('Details:'));
  log('─'.repeat(60));

  if (!options.full) {
    const lines = plan.details.split('\\n');
    if (lines.length > 20) {
      const truncatedLines = lines.slice(0, 20);
      log(truncatedLines.join('\\n'));
      log(chalk.gray(`... and ${lines.length - 20} more lines (use --full to see all)`));
    } else {
      log(plan.details);
    }
  } else {
    log(plan.details);
  }
}
```

**Issue:** The code already looks correct, but the escape sequences `\\n` suggest the newlines might not be handled properly. Test to confirm this works as expected, or if `plan.details` is being read as a literal string with `\n` instead of actual newlines.

**Fix:** Ensure details are displayed completely when `--full` is used. May need to verify the YAML parsing preserves multi-line strings correctly.

### 2. Add Inverse Relationship Display (after line 256)

Add these new sections after the existing "Dependencies" section:

```typescript
// Display inverse relationships
if (plan.id) {
  // Import the utility functions from plans.ts
  const { getBlockedPlans, getChildPlans, getDiscoveredPlans } = await import('../plans.js');

  // Show plans that are blocked by this one
  const blockedPlans = getBlockedPlans(plan.id, allPlans);
  if (blockedPlans.length > 0) {
    log('\n' + chalk.bold('Blocks These Plans:'));
    log('─'.repeat(60));
    for (const blocked of blockedPlans) {
      const statusIcon = blocked.status === 'done' ? '✓' :
                        blocked.status === 'in_progress' ? '⏳' : '○';
      const statusColor = blocked.status === 'done' ? chalk.green :
                         blocked.status === 'in_progress' ? chalk.yellow : chalk.gray;
      log(`  ${statusIcon} ${chalk.cyan(blocked.id)} - ${getCombinedTitleFromSummary(blocked)} ${statusColor(`[${blocked.status || 'pending'}]`)}`);
    }
  }

  // Show child plans
  const children = getChildPlans(plan.id, allPlans);
  if (children.length > 0) {
    log('\n' + chalk.bold('Child Plans:'));
    log('─'.repeat(60));
    for (const child of children) {
      const statusIcon = child.status === 'done' ? '✓' :
                        child.status === 'in_progress' ? '⏳' : '○';
      const statusColor = child.status === 'done' ? chalk.green :
                         child.status === 'in_progress' ? chalk.yellow : chalk.gray;
      log(`  ${statusIcon} ${chalk.cyan(child.id)} - ${getCombinedTitleFromSummary(child)} ${statusColor(`[${child.status || 'pending'}]`)}`);
    }
  }

  // Show plans discovered from this one
  const discovered = getDiscoveredPlans(plan.id, allPlans);
  if (discovered.length > 0) {
    log('\n' + chalk.bold('Plans Discovered From This:'));
    log('─'.repeat(60));
    for (const d of discovered) {
      const statusColor = d.status === 'done' ? chalk.green :
                         d.status === 'in_progress' ? chalk.yellow : chalk.gray;
      log(`  • ${chalk.cyan(d.id)} - ${getCombinedTitleFromSummary(d)} ${statusColor(`[${d.status || 'pending'}]`)}`);
    }
  }

  // Show the source if this was discovered from another plan
  if (plan.discoveredFrom) {
    const source = allPlans.get(plan.discoveredFrom);
    log('\n' + chalk.bold('Discovered From:'));
    log('─'.repeat(60));
    if (source) {
      log(`  • ${chalk.cyan(plan.discoveredFrom)} - ${getCombinedTitleFromSummary(source)}`);
    } else {
      log(`  • ${chalk.cyan(plan.discoveredFrom)} ${chalk.red('[Plan not found]')}`);
    }
  }
}
```

### 3. Update Short Mode (Optional)

Consider whether short mode (`--short`) should also show a summary of inverse relationships, e.g.:
- "Blocks: 2 plans"
- "Children: 3 plans"
- "Discovered: 1 plan"

## Testing

### Manual Testing Scenarios

1. **Full details display:**
   - Create a plan with long details (>20 lines)
   - Run `rmplan show <plan>` - should truncate
   - Run `rmplan show <plan> --full` - should show ALL lines

2. **Inverse relationships:**
   - Create plan A
   - Create plan B with `--depends-on A`
   - Create plan C with `--parent A`
   - Create plan D with `--discovered-from A`
   - Run `rmplan show A`
   - Verify it shows:
     - "Blocks These Plans: B"
     - "Child Plans: C"
     - "Plans Discovered From This: D"

3. **Edge cases:**
   - Plan with no relationships (should show nothing extra)
   - Plan with missing references (should show "not found" warnings)
   - Very long relationship lists (test formatting)

### Automated Tests

File: `src/rmplan/commands/show.test.ts`

Add tests for:
1. Full details flag removes truncation
2. Inverse relationships display correctly
3. Missing references handled gracefully
4. Short mode doesn't break with new features

## User Experience

After this change, agents running `rmplan show <plan> --full` will see:

1. **Complete context** - No truncated details
2. **Impact visibility** - See what plans are blocked by this one
3. **Hierarchy awareness** - See all child plans at a glance
4. **Discovery tracking** - Understand what work this plan generated

This is especially useful for autonomous agents that need to understand the full scope of work before making decisions about plan modifications or execution order.

## Dependencies

Depends on plan 129 for the utility functions (`getBlockedPlans`, `getChildPlans`, `getDiscoveredPlans`).

## MCP Integration

The existing `get-plan` MCP tool (src/rmplan/mcp/generate_mode.ts:425-431) already provides plan details but uses a simplified text format via `buildPlanContext()`. 

Consider enhancing it to include inverse relationships:

```typescript
export async function handleGetPlanTool(
  args: GetPlanArguments,
  context: GenerateModeRegistrationContext
): Promise<string> {
  const { plan, planPath } = await resolvePlan(args.plan, context);
  const contextBlock = buildPlanContext(plan, planPath, context);
  
  // Add inverse relationships if plan has an ID
  if (plan.id) {
    const tasksDir = await resolveTasksDir(context.config);
    const { plans: allPlans } = await readAllPlans(tasksDir);
    
    const blockedPlans = getBlockedPlans(plan.id, allPlans);
    const children = getChildPlans(plan.id, allPlans);
    const discovered = getDiscoveredPlans(plan.id, allPlans);
    
    const relationships = [];
    if (blockedPlans.length > 0) {
      relationships.push(`\nBlocks these plans: ${blockedPlans.map(p => p.id).join(', ')}`);
    }
    if (children.length > 0) {
      relationships.push(`\nChild plans: ${children.map(p => p.id).join(', ')}`);
    }
    if (discovered.length > 0) {
      relationships.push(`\nPlans discovered from this: ${discovered.map(p => p.id).join(', ')}`);
    }
    
    if (relationships.length > 0) {
      return `${contextBlock}\n${relationships.join('\n')}`;
    }
  }
  
  return contextBlock;
}
```

This way agents using the MCP server get the same visibility as the CLI show command.
