---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Update documentation for autonomous agent features
goal: ""
id: 136
uuid: 95417c3d-94db-4555-b529-0debb66f9301
status: pending
priority: low
temp: false
dependencies:
  - 129
  - 130
  - 131
  - 132
  - 133
  - 134
  - 135
parent: 128
createdAt: 2025-10-26T22:41:37.508Z
updatedAt: 2025-10-27T08:39:04.201Z
tasks: []
---

## Overview

Update project documentation to reflect all the new autonomous agent features. This ensures users (both human and AI) can discover and use the new capabilities.

## Files to Update

### 1. README.md

Add new section after rmplan introduction:

```markdown
### Autonomous Agent Features

rmplan includes several features designed for autonomous agents:

- **Discovery tracking**: Track which plans led to discovering new work with `discoveredFrom` field
- **Ready command**: `rmplan ready` shows prioritized list of executable plans  
- **Enhanced visibility**: `rmplan show --full` displays complete details and inverse relationships
- **Dynamic task management**: Add/remove tasks without manual YAML editing
- **Agent guidance**: Run `rmplan` with no args to see agent-friendly workflow guide

See [Autonomous Agent Guide](#autonomous-agent-guide) for details.
```

Add detailed section:

```markdown
## Autonomous Agent Guide

### Key Concepts for Agents

...

### Common Workflows

**When you discover out-of-scope work:**
```bash
rmplan add "Fix discovered bug" --discovered-from <current-plan-id> -p high
```

**When breaking down a large plan:**
```bash
rmplan add "Phase 1" --parent <parent-id>
rmplan add "Phase 2" --parent <parent-id> --depends-on <phase-1-id>
```

**When you need to add a task mid-execution:**
```bash
rmplan add-task <plan> --title "Additional requirement" --description "..."
```

### Command Reference

- `rmplan ready` - See what's ready to work on
- `rmplan show <plan> --full` - Get complete context
- `rmplan add-task <plan>` - Add tasks dynamically
- `rmplan remove-task <plan>` - Remove obsolete tasks
- `rmplan set <plan> --discovered-from <id>` - Track discovery
```

### 2. CLAUDE.md

Add section for agents working on rmplan codebase:

```markdown
## Working with Plan Files

### New Schema Fields

- `discoveredFrom`: Tracks which plan led to discovering this work
  - Stored in plan files
  - Displayed in show command
  - Set via `--discovered-from` flag on add/set commands

### Inverse Relationships

Three new utility functions compute inverse relationships:
- `getBlockedPlans(id, allPlans)` - Plans that depend on this one
- `getChildPlans(id, allPlans)` - Plans with this as parent
- `getDiscoveredPlans(id, allPlans)` - Plans discovered from this one

These should be used instead of storing redundant arrays.

### Testing Plan Commands

Use real filesystem for tests:
```typescript
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-test-'));
// Create test plan files
// Run command
// Verify results
// Clean up tempDir
```
```

### 3. Command Help Text

Update help strings in `src/rmplan/rmplan.ts`:

- Add examples to command descriptions
- Mention `--full` flag in show command help
- Explain agent use cases in appropriate commands

### 4. Schema JSON

File: `schema/rmplan-plan-schema.json`

Add `discoveredFrom` to the JSON schema with description and validation rules.

## Documentation Checklist

- [ ] Update README.md with autonomous agent features section
- [ ] Add detailed agent guide to README.md
- [ ] Update CLAUDE.md with schema changes and testing notes
- [ ] Update command help text where applicable
- [ ] Update JSON schema file
- [ ] Add examples to each new command's help text
- [ ] Document inverse relationship utilities
- [ ] Add migration notes if needed (existing plans work without changes)

## Testing

- Read through documentation as if you're a new agent
- Try following the examples
- Verify all code snippets are accurate
- Check that links work
- Ensure schema JSON validates correctly

## Dependencies

Depends on all implementation plans (129-135) being complete so documentation matches reality.
