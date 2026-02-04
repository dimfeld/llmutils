---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Update documentation for autonomous agent features
goal: ""
id: 136
uuid: 95417c3d-94db-4555-b529-0debb66f9301
status: done
priority: low
dependencies:
  - 129
  - 130
  - 131
  - 132
  - 133
  - 134
  - 135
parent: 128
references:
  "128": f69d418b-aaf1-4c29-88a9-f557baf8f81e
  "129": 1993c51d-3c29-4f8d-9928-6fa7ebea414c
  "130": 44241afa-1440-4f8c-8ff5-c6276ed5ba78
  "131": 9fac9f74-787e-46e9-a41c-b1fc86e28f1e
  "132": 7ebf9d14-805e-4178-83a7-a1e91154de23
  "133": cf076ee0-2c50-48ce-a549-c267c7fe57fb
  "134": b03a07b6-27d4-44e0-9a3b-b798f50bfed2
  "135": ac0b9e9d-cd95-45f1-8ded-15074bd6c800
createdAt: 2025-10-26T22:41:37.508Z
updatedAt: 2026-01-02T03:50:29.922Z
tasks: []
---

## Overview

Update project documentation to reflect all the new autonomous agent features. This ensures users (both human and AI) can discover and use the new capabilities.

## Files to Update

### 1. README.md

Add new section after tim introduction:

```markdown
### Autonomous Agent Features

tim includes several features designed for autonomous agents:

- **Discovery tracking**: Track which plans led to discovering new work with `discoveredFrom` field
- **Ready command**: `tim ready` shows prioritized list of executable plans  
- **Enhanced visibility**: `tim show --full` displays complete details and inverse relationships
- **Dynamic task management**: Add/remove tasks without manual YAML editing
- **Agent guidance**: Run `tim` with no args to see agent-friendly workflow guide

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
tim add "Fix discovered bug" --discovered-from <current-plan-id> -p high
```

**When breaking down a large plan:**
```bash
tim add "Phase 1" --parent <parent-id>
tim add "Phase 2" --parent <parent-id> --depends-on <phase-1-id>
```

**When you need to add a task mid-execution:**
```bash
tim add-task <plan> --title "Additional requirement" --description "..."
```

### Command Reference

- `tim ready` - See what's ready to work on
- `tim show <plan> --full` - Get complete context
- `tim add-task <plan>` - Add tasks dynamically
- `tim remove-task <plan>` - Remove obsolete tasks
- `tim set <plan> --discovered-from <id>` - Track discovery
```

### 2. CLAUDE.md

Add section for agents working on tim codebase:

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
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-test-'));
// Create test plan files
// Run command
// Verify results
// Clean up tempDir
```
```

### 3. Command Help Text

Update help strings in `src/tim/tim.ts`:

- Add examples to command descriptions
- Mention `--full` flag in show command help
- Explain agent use cases in appropriate commands

### 4. Schema JSON

File: `schema/tim-plan-schema.json`

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
