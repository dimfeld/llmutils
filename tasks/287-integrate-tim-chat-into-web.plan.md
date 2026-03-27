---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: integrate "tim chat" into web
goal: ""
id: 287
uuid: a589cad0-16c2-42e1-a026-7a0949e37d0b
status: pending
priority: medium
planGeneratedAt: 2026-03-26T08:14:20.727Z
createdAt: 2026-03-26T06:55:28.495Z
updatedAt: 2026-03-26T08:14:20.728Z
tasks:
  - title: Add spawnChatProcess to plan_actions.ts
    done: false
    description: 'Add a spawnChatProcess() export function to
      src/lib/server/plan_actions.ts following the pattern of
      spawnGenerateProcess/spawnAgentProcess. Uses args: ["chat", "--plan",
      String(planId), "--auto-workspace", "--no-terminal-input"].'
  - title: Add tests for spawnChatProcess in plan_actions.test.ts
    done: false
    description: "Add 4 tests in src/lib/server/plan_actions.test.ts mirroring the
      existing pattern: successful detached spawn with unref, early exit with
      stderr, early exit without stderr (exit code fallback), and Bun.spawn
      throw. Verify spawn args include --plan flag."
  - title: Add startChat remote command to plan_actions.remote.ts
    done: false
    description: Add isPlanEligibleForChat() (returns true for any existing plan
      regardless of status), import spawnChatProcess, and export startChat
      command using launchTimCommand() in src/lib/remote/plan_actions.remote.ts.
  - title: Add tests for startChat in plan_actions.remote.test.ts
    done: false
    description: 'Add describe("startChat") block in
      src/lib/remote/plan_actions.remote.test.ts. Tests: rejects missing plans,
      allows done/cancelled/deferred plans, allows plans with/without tasks,
      returns already_running for all session types, ignores offline sessions,
      rejects no primary workspace, successful spawn, spawn failures, launch
      lock, cross-project isolation. Update vi.mock to include
      spawnChatProcess.'
  - title: Update PlanDetail.svelte with chat button and states
    done: false
    description: "Add chat launch UI to src/lib/components/PlanDetail.svelte: import
      startChat, add startingChat state and handleChat() handler, update
      starting/controlsDisabled deriveds. Add showChatOnly derived for when
      neither generate nor agent shown. Three UI states: (1)
      showGenerateWithAgent adds Chat to dropdown, (2) showAgentOnly converts to
      ButtonGroup with Chat in dropdown, (3) showChatOnly shows standalone
      violet Chat button. Add violet color theming to active session indicator
      for chat command."
  - title: Format, type-check, and run tests
    done: false
    description: Run bun run format, bun run check, and bun run test-web to verify
      all changes compile and pass.
tags: []
generatedBy: agent
promptsGeneratedAt: 2026-03-26T08:14:20.727Z
---

Just like we have generate and agent commands launchable from the web ui, we should also be able to launch a chat session from the web ui, with a workspace roundtrip like those commands do.

## Expected Behavior/Outcome

Users can launch a `tim chat` session from the web UI's plan detail view. The chat session spawns as a detached process with `--auto-workspace --no-terminal-input`, follows the same workspace roundtrip pattern as generate/agent, and appears as a live session in the sessions tab. The active session indicator shows "Chat Running..." with appropriate styling.

### Relevant States
- **No tasks (stub plan, non-terminal)**: Chat available in dropdown alongside "Run Agent" (Generate is primary)
- **Incomplete tasks (non-terminal)**: Chat available in dropdown (Run Agent is primary)
- **All tasks complete OR terminal status (done/cancelled/deferred)**: Chat button shown as standalone primary action (violet themed). Chat is always available regardless of plan status.
- **Starting**: Button shows spinner + "Starting..." text, controls disabled
- **Started (waiting for session)**: Success message shown, controls disabled for 30s timeout
- **Active session**: "Chat Running..." link shown (replaces all buttons), links to session detail, violet themed
- **Already running**: Returns existing session connection ID
- **Error**: Error message displayed (spawn failure, no workspace, etc.)

## Key Findings

### Product & User Story
As a user viewing a plan in the web UI, I want to launch a chat session associated with that plan so I can interactively work on the plan's code in a workspace without leaving the web interface. The chat session should use the same workspace infrastructure (auto-workspace selection, roundtrip sync) as generate and agent commands.

### Design & UX Approach
The chat button should be added to the plan detail actions in `PlanDetail.svelte` across three UI states:
1. **No tasks (stub plan, non-terminal)**: Generate is primary button, dropdown contains "Run Agent" and "Chat"
2. **Incomplete tasks (non-terminal)**: Run Agent is primary button, dropdown contains "Chat"
3. **All tasks complete OR terminal status**: Standalone "Chat" button (violet themed) — chat is always available regardless of plan status

Color theming: Chat uses violet (`bg-violet-600`/`bg-violet-500` dark) to distinguish from generate (blue) and agent (emerald/green). The active session indicator for chat also uses violet.

The active session indicator already handles arbitrary command names via its fallback: `${command.charAt(0).toUpperCase() + command.slice(1)} Running...`, so "chat" sessions will display as "Chat Running..." automatically. We add explicit chat color handling alongside the existing agent/generate colors.

### Technical Plan & Risks
This is a low-risk, highly mechanical change. The entire launch infrastructure is already generalized via `launchTimCommand()` on the server side and `spawnTimProcess()` for process spawning. The only new code needed is:
1. A `spawnChatProcess()` function (3 lines)
2. An eligibility check function for chat (trivial — any existing plan is eligible)
3. A `startChat` remote command (5 lines)
4. UI changes to add the Chat option to PlanDetail.svelte
5. Tests mirroring the existing generate/agent test patterns

No architectural changes needed. The session discovery, WebSocket connection, SSE streaming, and session management all work command-agnostically already. Tests already verify that chat sessions block generate/agent launches.

### Pragmatic Effort Estimate
Small feature. The existing patterns are well-established and the code changes are minimal. Each file change is a few lines following existing patterns.

## Acceptance Criteria

- [ ] User can click "Chat" from plan detail dropdown and a chat session launches
- [ ] Chat session appears in the sessions tab with "Chat Running..." indicator
- [ ] Duplicate launch prevention works (launch lock + active session detection)
- [ ] Chat button is available for plans in any status, including terminal statuses (done/cancelled/deferred)
- [ ] Spawn failures surface error messages to the user
- [ ] All new code paths are covered by tests

## Dependencies & Constraints

- **Dependencies**: Relies on existing `launchTimCommand()` infrastructure, `spawnTimProcess()`, launch lock system, and session discovery
- **Technical Constraints**: The `tim chat` CLI command must already support `--auto-workspace --no-terminal-input` flags and `--plan <planId>` for plan association (it does, per research)

## Implementation Notes

### Recommended Approach
Follow the exact same pattern used by generate and agent. The codebase has a clear, well-factored pattern where adding a new launchable command requires changes in exactly 4 files plus their test files.

### Potential Gotchas
- The chat command uses `--plan <planId>` rather than a positional `<planId>` argument (unlike generate/agent which take the plan ID as a positional arg). Need to verify the exact CLI invocation.
- The `tim chat` command's eligibility is the broadest — any existing plan is eligible, including terminal statuses (done/cancelled/deferred).
- The existing active session indicator in PlanDetail.svelte already handles unknown commands gracefully via its fallback formatting, so "Chat Running..." styling will work, but we should consider adding explicit chat-specific color theming (e.g., a distinct color from generate's blue and agent's green).

## Research

### Architecture Overview
The web UI launches CLI commands through a three-layer architecture:

1. **Remote commands** (`src/lib/remote/plan_actions.remote.ts`): SvelteKit `command()` functions that validate input, check eligibility, prevent duplicates, and delegate to spawn functions
2. **Process spawning** (`src/lib/server/plan_actions.ts`): Thin wrappers around `spawnTimProcess()` that construct the CLI arguments
3. **UI integration** (`src/lib/components/PlanDetail.svelte`): Buttons/dropdowns that call remote commands and display state

### Key Files Explored

#### `src/lib/server/plan_actions.ts`
Contains `spawnTimProcess()` (the generic spawner) and command-specific wrappers:
- `spawnGenerateProcess(planId, cwd)` → `['generate', String(planId), '--auto-workspace', '--no-terminal-input']`
- `spawnAgentProcess(planId, cwd)` → `['agent', String(planId), '--auto-workspace', '--no-terminal-input']`

The spawner runs `Bun.spawn(['tim', ...args], { cwd, detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })`, waits 500ms for early exit detection, then unrefs the process.

#### `src/lib/remote/plan_actions.remote.ts`
Contains the SvelteKit remote commands and the shared `launchTimCommand()` function. Flow:
1. Load plan from DB by UUID
2. Run eligibility check
3. Check for active session via `sessionManager.hasActiveSessionForPlan(uuid)`
4. Check launch lock via `isPlanLaunching(uuid)`
5. Get primary workspace path
6. Set launch lock
7. Spawn process
8. Return `{ status: 'started', planId }` or `{ status: 'already_running', connectionId? }`

Eligibility functions:
- Generate: `plan.tasks.length === 0 && !terminal_status`
- Agent: `!terminal_status && !(tasks.length > 0 && all_done)`

#### `src/lib/components/PlanDetail.svelte`
UI component showing plan details with action buttons. Key patterns:
- `activeSession` derived from `sessionManager.sessions` matching `planUuid`
- `showAgentOnly` = has incomplete tasks and not ineligible
- `showGenerateWithAgent` = no tasks and not ineligible
- Active session indicator already handles arbitrary commands via fallback: `${command.charAt(0).toUpperCase() + command.slice(1)} Running...`
- Uses `ButtonGroup` with `DropdownMenu` for secondary actions

#### `src/tim/commands/chat.ts`
The chat command accepts:
- Positional `[prompt]` (optional)
- `--plan <path|id>` for plan association
- `--workspace`, `--auto-workspace`, `--new-workspace` for workspace mode
- `--no-terminal-input` to disable terminal forwarding
- `--base` for branch specification
- `--model`, `--executor`, etc.

Key difference from generate/agent: chat takes `--plan <id>` as a named option, not a positional argument. When `--plan` is provided without explicit workspace flags, it implies `--auto-workspace`.

#### `src/lib/server/plan_actions.test.ts`
Tests for spawn functions follow a pattern: test successful spawn, early exit with stderr, early exit without stderr, and Bun.spawn throw. Each command has 4 tests.

#### `src/lib/remote/plan_actions.remote.test.ts`
Comprehensive tests using `invokeCommand()` helper with a seeded in-memory database. Tests cover: missing plans, ineligibility, active sessions (for all command types), offline sessions, no workspace, successful spawn, spawn failures, launch locks, and cross-project isolation.

### Existing Test Coverage for Chat Sessions
The test file already has tests verifying that active chat sessions block generate and agent launches:
- `startGenerate returns the active session when a chat session is already running` (line 160)
- `startAgent returns already_running when a chat session exists on the same plan` (line 427)

This confirms the session management already handles chat sessions correctly.

### Chat CLI Invocation Pattern
Based on chat.ts analysis, the spawn command should be:
```
['chat', '--plan', String(planId), '--auto-workspace', '--no-terminal-input']
```
Note: unlike generate/agent which take planId as a positional arg, chat uses `--plan` flag.

## Implementation Guide

### Step 1: Add `spawnChatProcess()` to `src/lib/server/plan_actions.ts`

Add a new export function following the exact pattern of `spawnGenerateProcess` and `spawnAgentProcess`:

```typescript
export async function spawnChatProcess(planId: number, cwd: string): Promise<SpawnProcessResult> {
  return spawnTimProcess(planId, ['chat', '--plan', String(planId), '--auto-workspace', '--no-terminal-input'], cwd);
}
```

Key difference: chat uses `--plan <id>` as a named option rather than a positional argument.

### Step 2: Add tests for `spawnChatProcess` in `src/lib/server/plan_actions.test.ts`

Add 4 tests mirroring the existing pattern:
1. Successful spawn in detached mode with unref
2. Early exit with stderr text
3. Early exit without stderr (fallback to exit code message)
4. Bun.spawn throw handling

Verify the spawn args are `['tim', 'chat', '--plan', '189', '--auto-workspace', '--no-terminal-input']`.

### Step 3: Add `startChat` remote command to `src/lib/remote/plan_actions.remote.ts`

Add:
1. Import `spawnChatProcess` from the plan_actions module
2. An `isPlanEligibleForChat()` function — chat is always available as long as the plan exists:
   ```typescript
   function isPlanEligibleForChat(plan): plan is PlanDetailResult {
     return plan != null;
   }
   ```
3. A `startChat` export using the same `command()` pattern with `launchTimCommand()`

### Step 4: Add tests for `startChat` in `src/lib/remote/plan_actions.remote.test.ts`

Add a `describe('startChat', ...)` block mirroring the `startAgent` test suite. Key tests:
1. Rejects missing plans (404)
2. Allows done/cancelled/deferred plans (chat is always eligible)
3. Allows plans with tasks
4. Allows plans without tasks
5. Returns already_running for active sessions (test all command types: agent, generate, chat, review)
6. Ignores offline sessions
7. Rejects plans without primary workspace
8. Spawns from primary workspace successfully
9. Surfaces spawn failures
10. Launch lock prevents duplicate launches
11. Cross-project plan isolation

Update the `vi.mock('$lib/server/plan_actions.js')` to include `spawnChatProcess`.

### Step 5: Update `PlanDetail.svelte` UI

Add the chat button to the plan detail action area. The changes needed:
1. Import `startChat` from `$lib/remote/plan_actions.remote.js`
2. Add `startingChat` state variable
3. Add `handleChat()` async function following the `handleGenerate`/`handleRunAgent` pattern
4. Update `starting` and `controlsDisabled` derived states to include `startingChat`
5. Reset `startingChat` in `afterNavigate`
6. Add a new derived state `showChatOnly` for when neither generate nor agent buttons are shown — this covers both all-tasks-complete and terminal statuses. The condition is `!showGenerateWithAgent && !showAgentOnly`

UI state changes:
- **`showGenerateWithAgent`** (no tasks): Add "Chat" to the dropdown menu alongside "Run Agent"
- **`showAgentOnly`** (incomplete tasks): Convert from a single button to a `ButtonGroup` with "Run Agent" as primary and a dropdown containing "Chat"
- **`showChatOnly`** (all tasks complete OR terminal status): New standalone "Chat" button with violet styling (`bg-violet-600 hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600`)
- **Active session indicator**: Add explicit chat color handling with violet (`bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300`) and violet pulse dot (`bg-violet-500`), alongside existing blue (generate) and green (agent) colors

### Step 6: Format and verify

Run `bun run format` to format the code, `bun run check` for type checking, and `bun run test-web` for web tests.

### Manual Testing Steps
1. Open a plan with no tasks → verify Chat appears in dropdown alongside "Run Agent"
2. Open a plan with incomplete tasks → verify Chat appears in dropdown
3. Click Chat → verify process spawns, spinner shows, success message appears
4. Verify session appears in sessions tab with "Chat Running..." indicator
5. Try clicking Chat again → verify "already running" response
6. Open a done/cancelled/deferred plan → verify standalone Chat button is shown
7. Verify clicking the "Chat Running..." link navigates to the session detail
