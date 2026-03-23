---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: permissions mcp should always allow update-plan-tasks commands
goal: ""
id: 261
uuid: 5d32c3c2-3400-4157-8218-646f0a101ec7
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-03-23T21:05:46.941Z
promptsGeneratedAt: 2026-03-23T21:05:46.941Z
createdAt: 2026-03-23T19:36:32.913Z
updatedAt: 2026-03-23T21:33:45.522Z
tasks:
  - title: Define ALWAYS_ALLOWED_BASH_SUFFIXES constant in permissions_mcp_setup.ts
    done: true
    description: "Add an exported constant `ALWAYS_ALLOWED_BASH_SUFFIXES: string[]`
      containing `tim tools update-plan-tasks` in
      `src/tim/executors/claude_code/permissions_mcp_setup.ts`. Place it near
      the top of the file with the other constants. This will be the single
      source of truth imported by both executors."
  - title: Add suffix check to handlePermissionLine() in permissions_mcp_setup.ts
    done: true
    description: In `handlePermissionLine()` in
      `src/tim/executors/claude_code/permissions_mcp_setup.ts`, add a suffix
      check for Bash commands. Add a new block after the existing prefix check
      (after the `if (tool_name === BASH_TOOL_NAME &&
      Array.isArray(allowedValue))` block) that checks
      `ALWAYS_ALLOWED_BASH_SUFFIXES.some((suffix) =>
      command.trimEnd().endsWith(suffix))`. This should be a separate block so
      it runs regardless of whether prefix patterns are configured. If matched,
      auto-approve the request.
  - title: Add suffix check to isCommandAllowed() in app_server_approval.ts
    done: true
    description: "In `src/tim/executors/codex_cli/app_server_approval.ts`, import
      `ALWAYS_ALLOWED_BASH_SUFFIXES` from
      `../claude_code/permissions_mcp_setup.js` and add a suffix check in
      `isCommandAllowed()`. Add it early in the function, after the `allowed ===
      true` check: `const trimmedCommand = command.trimEnd(); if
      (ALWAYS_ALLOWED_BASH_SUFFIXES.some((suffix) =>
      trimmedCommand.endsWith(suffix))) return true;`"
  - title: Add tests for suffix auto-approval in permissions_mcp_setup.test.ts
    done: true
    description: "Add tests in
      `src/tim/executors/claude_code/permissions_mcp_setup.test.ts` using the
      existing socket server integration test pattern. Test cases: (1) piped
      command `echo {...} | tim tools update-plan-tasks` is auto-approved, (2)
      direct command `tim tools update-plan-tasks` is auto-approved, (3) command
      with trailing whitespace is auto-approved, (4) unrelated command still
      prompts for approval."
  - title: Add tests for suffix auto-approval in app_server_approval tests
    done: true
    description: "Add or extend tests for `isCommandAllowed()` in the Codex CLI
      approval tests. Verify: (1) piped `tim tools update-plan-tasks` commands
      are auto-approved, (2) direct invocation is auto-approved, (3) trailing
      whitespace is handled, (4) unrelated commands are not auto-approved."
changedFiles:
  - src/tim/executors/claude_code/permissions_mcp_setup.test.ts
  - src/tim/executors/claude_code/permissions_mcp_setup.ts
  - src/tim/executors/codex_cli/app_server_approval.test.ts
  - src/tim/executors/codex_cli/app_server_approval.ts
tags: []
---

When a bash command ends in `tim tools update-plan-tasks`, it should be autoapproved.

## Research

### Problem Overview

When a Claude Code subprocess invokes a Bash command that ends with `tim tools update-plan-tasks`, the permissions MCP currently prompts the user for approval. This command is safe (it only writes plan task data to a plan file) and should be auto-approved, similar to how `tim add`, `tim review`, `tim set-task-done`, and `tim subagent` are already auto-approved.

### Critical Discovery: "Ends In" vs "Starts With"

The existing permission system uses **prefix matching** (`command.startsWith(prefix)`) to auto-approve Bash commands. However, the description says the command **"ends in"** `tim tools update-plan-tasks`. This distinction matters because agents commonly construct commands like:

- `echo '{"plan":"123","tasks":[...]}' | tim tools update-plan-tasks` (piped input)
- `cat input.json | tim tools update-plan-tasks`

In these cases, the command **starts** with `echo` or `cat`, not `tim tools`. A simple prefix pattern `Bash(tim tools update-plan-tasks:*)` would NOT match these piped commands.

This means the implementation needs **suffix matching** in addition to (or instead of) prefix matching.

### Key Files and Their Roles

1. **`src/tim/executors/claude_code/run_claude_subprocess.ts`** — `getDefaultAllowedTools()` (lines 42-92): The single source of truth for default auto-approved tool patterns. Currently includes `Bash(tim add:*)`, `Bash(tim review:*)`, `Bash(tim set-task-done:*)`, `Bash(tim subagent:*)`.

2. **`src/tim/executors/claude_code/permissions_mcp_setup.ts`** — Core permission checking engine:
   - `parseAllowedToolsList()` (lines 152-199): Parses patterns like `Bash(git commit:*)` into a `Map<string, true | string[]>` where Bash maps to an array of command prefixes.
   - `handlePermissionLine()` (lines 434-613): The actual checking logic at line 479: `const isAllowed = allowedValue.some((prefix) => command.startsWith(prefix))`. This is the line that would need to support suffix matching.

3. **`src/tim/executors/claude_code/run_claude_subprocess.test.ts`** — Tests for `getDefaultAllowedTools()` and `buildAllowedToolsList()`. The "includes tim commands" test (lines 38-44) verifies expected patterns.

4. **`src/tim/executors/claude_code/permissions_mcp_setup.test.ts`** — Integration tests using Unix socket server for permission request/response flow. Uses `ModuleMocker` to mock prompt functions.

5. **`src/tim/executors/codex_cli/app_server_approval.ts`** — Also uses `parseAllowedToolsList()` for Codex CLI executor. Changes to the parsing logic would affect this too.

### Existing Permission Pattern System

**Pattern format**: `Bash(<command>:*)` where `:*` means "match anything after this prefix". Without `:*`, it's an exact match.

**Parsing** (`parseAllowedToolsList`):
- `Bash(git commit:*)` → prefix `"git commit"` — matches any command starting with `git commit`
- `Bash(pwd)` → prefix `"pwd"` — matches only exact `pwd`

**Checking** (`handlePermissionLine` line 479):
```typescript
const isAllowed = allowedValue.some((prefix) => command.startsWith(prefix));
```

### Approach: Hardcoded Suffix Matching

A configurable pattern syntax (e.g. `Bash(*:cmd)`) would be ideal but isn't feasible — Claude Code validates the allowed tools list and would reject unknown syntax. Instead, we hardcode a list of command suffixes that are always auto-approved, checked alongside the existing prefix patterns. The list should be defined as a simple constant array so adding more suffixes later is trivial.

### Codex CLI Integration

`src/tim/executors/codex_cli/app_server_approval.ts` has its own `isCommandAllowed()` function (line 80-91) that also uses `startsWith` for prefix matching. It needs the same suffix check. This function is self-contained (doesn't go through `parseAllowedToolsList` for the actual check), so a shared utility or duplicated constant is needed.

### Dependencies

- Both `permissions_mcp_setup.ts` (Claude Code) and `app_server_approval.ts` (Codex CLI) need the suffix check.
- A shared constant for the suffix list avoids duplication and ensures consistency.

## Implementation Guide

### Recommended Approach

Hardcode a list of always-allowed command suffixes, checked at the same points where prefix patterns are currently checked. The suffix list is defined as a constant array in one place and imported by both executors.

### Step-by-Step Implementation

#### Step 1: Create a shared constant for auto-approved suffixes

Define a constant like `ALWAYS_ALLOWED_BASH_SUFFIXES` in a shared location. The best place is `src/tim/executors/claude_code/permissions_mcp_setup.ts` since it already exports `parseAllowedToolsList()` used by the Codex CLI. Alternatively, a small shared module.

```typescript
/** Command suffixes that are always auto-approved for Bash tools.
 * A command is approved if it ends with any of these strings. */
export const ALWAYS_ALLOWED_BASH_SUFFIXES: string[] = [
  'tim tools update-plan-tasks',
];
```

#### Step 2: Add suffix check in `handlePermissionLine()` (Claude Code permissions)

In `src/tim/executors/claude_code/permissions_mcp_setup.ts`, after the existing prefix check at line 479, add a suffix check. The cleanest approach is to extend the existing `isAllowed` check:

```typescript
const trimmedCommand = command.trimEnd();
const isAllowed =
  allowedValue.some((prefix) => command.startsWith(prefix)) ||
  ALWAYS_ALLOWED_BASH_SUFFIXES.some((suffix) => trimmedCommand.endsWith(suffix));
```

This goes inside the `if (tool_name === BASH_TOOL_NAME && Array.isArray(allowedValue))` block, so it only runs for Bash commands. Alternatively, add the suffix check as a separate block right after the prefix check block, before falling through to the user prompt. The latter approach keeps the suffix check independent of whether there are any prefix patterns configured at all.

#### Step 3: Add suffix check in `isCommandAllowed()` (Codex CLI)

In `src/tim/executors/codex_cli/app_server_approval.ts`, update the `isCommandAllowed()` function (line 80-91). Import `ALWAYS_ALLOWED_BASH_SUFFIXES` from `permissions_mcp_setup.ts` and add:

```typescript
function isCommandAllowed(allowedToolsMap: AllowedToolsMap, command: string): boolean {
  const allowed = allowedToolsMap.get(BASH_TOOL_NAME);
  if (allowed === true) {
    return true;
  }

  const trimmedCommand = command.trimEnd();
  if (ALWAYS_ALLOWED_BASH_SUFFIXES.some((suffix) => trimmedCommand.endsWith(suffix))) {
    return true;
  }

  if (!Array.isArray(allowed)) {
    return false;
  }

  return allowed.some((prefix) => command.startsWith(prefix));
}
```

#### Step 4: Add unit tests for suffix matching in permissions_mcp_setup.test.ts

Test through the socket server integration test pattern already in use:
- Send a permission request for a Bash command `echo '{"plan":"42","tasks":[]}' | tim tools update-plan-tasks` → expect auto-approved
- Send a permission request for a Bash command `tim tools update-plan-tasks` (direct) → expect auto-approved (this needs a prefix entry in `getDefaultAllowedTools()` OR handling in the suffix check — since `tim tools update-plan-tasks` also ends with the suffix, the suffix check covers both cases)
- Send a permission request for an unrelated Bash command → expect prompt (not auto-approved)

#### Step 5: Add unit tests for suffix matching in app_server_approval.ts

Add or extend tests for `isCommandAllowed()` (or through the `createApprovalHandler` integration) to verify:
- Piped `tim tools update-plan-tasks` commands are auto-approved
- Direct `tim tools update-plan-tasks` is auto-approved
- Unrelated commands are not auto-approved

#### Step 6: Optionally add `tim tools update-plan-tasks` as a prefix pattern too

For belt-and-suspenders, add `'Bash(tim tools update-plan-tasks:*)'` to `getDefaultAllowedTools()` in `run_claude_subprocess.ts`. This covers the direct invocation case via the existing prefix system. The suffix check handles the piped case. This is optional since the suffix check alone covers both cases (a command `tim tools update-plan-tasks` also ends with the suffix string).

### Potential Gotchas

1. **Security of suffix matching**: A command like `malicious-command; tim tools update-plan-tasks` would match. However, `tim tools update-plan-tasks` is safe (writes plan files only), and the agent constructs these commands with Claude Code safeguards already in place.

2. **Trailing whitespace**: Use `command.trimEnd()` before the `endsWith` check to handle any trailing whitespace in the command string.

3. **The suffix check should run even when no prefix patterns exist**: Make sure the suffix check isn't gated on `Array.isArray(allowedValue)`. It should be a separate check that runs regardless of whether prefix patterns are configured.

### Manual Testing

1. Run `tim agent` or `tim generate` on a plan
2. Observe that `tim tools update-plan-tasks` commands (both direct and piped) are auto-approved without prompting
3. Verify that unrelated Bash commands still prompt for approval

### Expected Behavior/Outcome

Bash commands ending in `tim tools update-plan-tasks` are automatically approved by the permissions MCP without user interaction. This works for both direct invocation (`tim tools update-plan-tasks`) and piped invocation (`echo '...' | tim tools update-plan-tasks`).

### Key Findings

- **Product & User Story**: As an agent user, I want `tim tools update-plan-tasks` to be auto-approved so my plan generation workflows don't require manual intervention for safe operations.
- **Design & UX Approach**: No UI changes. The change is invisible to the user — commands that previously prompted now silently auto-approve.
- **Technical Plan & Risks**: Hardcode a suffix check for specific safe commands. Very low risk — the change is additive and isolated to the permission checking path. No type changes needed.
- **Pragmatic Effort Estimate**: Small change — 2-3 files modified, ~15 lines of logic changes, ~40 lines of tests.

### Acceptance Criteria

- [ ] Bash commands ending with `tim tools update-plan-tasks` (e.g. piped commands) are auto-approved in Claude Code permissions MCP
- [ ] Bash commands ending with `tim tools update-plan-tasks` are auto-approved in Codex CLI executor
- [ ] Direct invocation `tim tools update-plan-tasks` is also auto-approved
- [ ] Unrelated Bash commands are unaffected and still prompt for approval
- [ ] The suffix list is defined as a shared constant, easy to extend with more commands later
- [ ] All new code paths are covered by tests

### Dependencies & Constraints

- **Dependencies**: Relies on existing `handlePermissionLine()` in permissions_mcp_setup.ts and `isCommandAllowed()` in app_server_approval.ts.
- **Technical Constraints**: Cannot use a configurable pattern syntax because Claude Code validates the allowed tools list. Must be hardcoded. Must update both Claude Code and Codex CLI executors consistently.

## Current Progress
### Current State
- All 5 tasks completed. Plan is done.
### Completed (So Far)
- Defined `ALWAYS_ALLOWED_BASH_SUFFIXES` constant in permissions_mcp_setup.ts
- Added suffix check as separate block in `handlePermissionLine()` — runs independently of prefix patterns
- Added suffix check in `isCommandAllowed()` in app_server_approval.ts
- Added integration tests for both Claude Code and Codex CLI permission paths
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Suffix check placed as a separate block after the `allowedValue` check in `handlePermissionLine()`, not nested inside it, so it runs even when no prefix patterns are configured for Bash
### Lessons Learned
- None
### Risks / Blockers
- None
