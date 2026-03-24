---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Add a button that will open a new terminal window in the directory of the plan
goal: ""
id: 255
uuid: 7c48380a-336f-4335-ae4e-1de231841be6
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-03-22T08:09:33.010Z
promptsGeneratedAt: 2026-03-22T08:09:33.010Z
createdAt: 2026-03-22T07:26:55.822Z
updatedAt: 2026-03-24T00:55:28.986Z
tasks:
  - title: Add terminalApp config field to configSchema.ts
    done: true
    description: Add a new optional string field alongside terminalInput. Do NOT use
      .default() — apply default at point of use.
  - title: Add openTerminalInDirectory function to terminal_control.ts
    done: true
    description: "New exported async function: openTerminalInDirectory(directory,
      terminalApp?, deps?). Validates directory exists, resolves app name
      (default WezTerm), runs open -a <app> <dir> on macOS, throws on other
      platforms or failure."
  - title: Add tests for openTerminalInDirectory in terminal_control.test.ts
    done: true
    description: "Test cases: happy path with default terminal, custom terminal app,
      directory not found error, non-macOS platform error, spawn failure error."
  - title: Add openTerminal remote command in session_actions.remote.ts
    done: true
    description: "New command export with zod schema {directory: string}. Reads
      config.terminalApp via getServerContext() and passes to
      openTerminalInDirectory."
  - title: Mount Toaster component in root layout
    done: true
    description: Add <Toaster /> from src/lib/components/ui/sonner/ to
      src/routes/+layout.svelte for app-wide toast notifications.
  - title: Add openTerminalInDirectory method to SessionManager
    done: true
    description: Add method to SessionManager in session_state.svelte.ts that calls
      the openTerminal remote command. Let errors propagate for toast handling
      by callers.
  - title: Add Open Terminal button to SessionRow.svelte
    done: true
    description: AppWindow icon button, visible on hover when workspacePath exists.
      Calls sessionManager.openTerminalInDirectory, catches errors and shows
      toast.error. Uses stopPropagation/preventDefault.
  - title: Add Open Terminal button to SessionDetail.svelte
    done: true
    description: AppWindow icon button in session header alongside existing
      activate-pane button. Visible when workspacePath exists. Always visible
      (not hover-only). Toast error on failure.
  - title: Add Open Terminal button to PlanDetail.svelte
    done: true
    description: AppWindow icon button next to each workspace path in the Assigned
      Workspace section. Replace plain div with flex row containing path text
      and button. Toast error on failure.
changedFiles:
  - src/lib/components/PlanDetail.svelte
  - src/lib/components/SessionDetail.svelte
  - src/lib/components/SessionRow.svelte
  - src/lib/remote/session_actions.remote.test.ts
  - src/lib/remote/session_actions.remote.ts
  - src/lib/server/terminal_control.test.ts
  - src/lib/server/terminal_control.ts
  - src/lib/stores/session_state.svelte.ts
  - src/lib/stores/session_state.test.ts
  - src/routes/+layout.svelte
  - src/tim/configSchema.test.ts
  - src/tim/configSchema.ts
tags: []
---

This button should be available on
- the session list
- when viewing the plan, if the plan is assigned to a workspace

## Expected Behavior/Outcome

A new "Open Terminal" button appears in three locations in the web UI:
1. **Session List (SessionRow)**: An icon button that opens a new terminal window in the session's workspace directory. Visible on hover alongside the existing terminal-activate button.
2. **Session Detail (SessionDetail)**: Same button in the session detail header, alongside the existing terminal-activate button.
3. **Plan Detail (PlanDetail)**: A button in the "Assigned Workspace" section that opens a new terminal in the workspace directory. Only visible when the plan has a workspace assignment.

Clicking the button opens a **new** terminal window/tab in the appropriate directory (the workspace path). This is distinct from the existing "activate terminal pane" button, which focuses an already-existing WezTerm pane.

### States
- **Button visible**: Workspace path is available (session has `workspacePath`, or plan has assignment with workspace paths)
- **Button hidden**: No workspace path available
- **Loading**: Brief loading state while the server spawns the terminal
- **Error**: If terminal spawn fails (e.g. terminal emulator not found), show error feedback

## Key Findings

### Product & User Story
As a developer using the tim web interface, I want to quickly open a terminal in a plan's or session's workspace directory so I can run commands, inspect files, or debug issues without manually navigating to the directory.

### Design & UX Approach
- Place the button alongside existing action buttons using the same hover-reveal pattern (SessionRow) or always-visible pattern (PlanDetail assignment section)
- Use a distinct icon to differentiate from the existing "focus pane" terminal icon — e.g. `AppWindow` or `ExternalLink` + `Terminal` combo from lucide-svelte
- The button should feel lightweight and instant — spawn the terminal and return immediately

### Technical Plan & Risks
- **Approach**: Add a new server-side function `openTerminalInDirectory(directory: string, terminalApp?: string)` in `terminal_control.ts`. The terminal emulator is configurable via a new `terminalApp` field in the tim config schema (`configSchema.ts`).
- **Terminal emulator choice**: Configurable via tim config. If set (e.g. `"wezterm"`, `"Terminal"`, `"iTerm"`), uses `open -a <terminalApp> <dir>` on macOS. If unset, defaults to `"WezTerm"` since that's the terminal this project already integrates with.
- **Risk**: Cross-platform support — the initial implementation targets macOS (darwin) only, matching the existing `bringWeztermToFront` pattern
- **Risk**: The workspace path might not exist on disk if a workspace was deleted but the DB record remains

### Pragmatic Effort Estimate
Small feature — touches ~8 files with ~150-200 lines of new code plus tests.

## Acceptance Criteria

- [ ] User can click the "Open Terminal" button on a session row and a new terminal window opens in that session's workspace directory
- [ ] User can click the "Open Terminal" button on a session detail header and a terminal opens in that session's workspace directory
- [ ] User can click the "Open Terminal" button on a plan detail view (when assigned to a workspace) and a terminal opens in that workspace directory
- [ ] Terminal app is configurable via `terminalApp` field in tim config, defaulting to WezTerm
- [ ] The button is hidden when no workspace path is available
- [ ] Error feedback is shown if the terminal cannot be opened
- [ ] Server-side function validates the directory exists before attempting to open
- [ ] All new code paths are covered by tests

## Dependencies & Constraints

- **Dependencies**: Relies on existing `terminal_control.ts` infrastructure and `TerminalControlDeps` dependency injection pattern
- **Dependencies**: Relies on existing SvelteKit `command()` remote action pattern from `session_actions.remote.ts`
- **Dependencies**: Relies on `configSchema.ts` and `loadEffectiveConfig` for config-driven terminal app selection
- **Technical Constraints**: macOS only (darwin) for initial implementation, matching existing terminal control scope
- **Technical Constraints**: Workspace path must be a real directory on the local filesystem

## Implementation Notes

### Recommended Approach
Add a `terminalApp` config field to `configSchema.ts`, add `openTerminalInDirectory()` to `terminal_control.ts` using `open -a <app> <dir>`, expose it via a new remote command that reads config, and wire up buttons in `SessionRow.svelte`, `SessionDetail.svelte`, and `PlanDetail.svelte`. Error feedback via toast notifications using `svelte-sonner`.

### Potential Gotchas
- The existing `TerminalControlDeps` interface has `fileExists` already available — use it to validate the directory before spawning
- `open -a <app> <dir>` works for WezTerm, Terminal.app, iTerm, and most macOS terminal emulators — it's the simplest cross-app approach
- Per CLAUDE.md: do NOT add `.default()` to the zod schema field. Apply the default (`"WezTerm"`) at the point of use in `openTerminalInDirectory`

## Research

### Overview
This feature adds a "quick open terminal" button to the web UI that spawns a new terminal window/tab in a specific directory. Three locations need the button: session list rows, the session detail header, and the plan detail view's workspace assignment section.

### Critical Discoveries

1. **Existing terminal infrastructure**: `src/lib/server/terminal_control.ts` already has the full WezTerm integration pattern with dependency injection (`TerminalControlDeps`), path resolution (`resolveWeztermPath`), and subprocess spawning. The new function should follow the same pattern.

2. **Remote command pattern**: `src/lib/remote/session_actions.remote.ts` shows the exact pattern for server-side commands callable from the browser. Uses SvelteKit's `command()` with Zod schema validation. Adding `openTerminalInDirectory` follows the same pattern.

3. **Session workspace data**: `SessionRow.svelte` already derives `workspaceLabel` from `session.sessionInfo.workspacePath`. The full absolute path is available for the terminal spawn.

4. **Plan assignment data**: `PlanDetail.svelte` renders `plan.assignment.workspacePaths` (an array of strings). Each is an absolute filesystem path suitable for opening a terminal.

5. **WezTerm new window command**: `wezterm start --cwd <directory>` opens a new WezTerm window in the specified directory. This is different from `wezterm cli spawn` which creates a new pane in an existing window. The `start` subcommand is the right choice for a distinct "open new terminal" action.

6. **macOS fallback**: `open -a Terminal <dir>` opens Terminal.app in the given directory. Could be used as a fallback when WezTerm is not available.

### Notable Files Inspected

| File | Key Insight |
|------|-------------|
| `src/lib/server/terminal_control.ts` | Full terminal control infrastructure; `resolveWeztermPath()` and `TerminalControlDeps` are reusable |
| `src/lib/remote/session_actions.remote.ts` | Pattern for adding new remote commands; `activateSessionTerminalPane` is the closest analog |
| `src/lib/components/SessionRow.svelte` | Has `workspacePath` data; existing hover-button pattern for terminal activate |
| `src/lib/components/PlanDetail.svelte` | Has `plan.assignment.workspacePaths`; assignment section at line 247-263 is where button goes |
| `src/lib/stores/session_state.svelte.ts` | `SessionManager` class where client-side terminal methods live (e.g., `activateTerminalPane`) |
| `src/lib/server/terminal_control.test.ts` | Test pattern using mocked `TerminalControlDeps` — new tests should follow same approach |
| `src/common/process.ts` | `spawnAndLogOutput` used by all terminal commands with `{ quiet: true }` |

### Architectural Details

**Button in SessionRow**: The session row already has a hover-visible terminal button pattern (lines 89-98). The new button should sit beside it. It uses `session.sessionInfo.workspacePath` — no additional data fetching needed.

**Button in PlanDetail**: The assignment section (lines 247-263) lists workspace paths as plain text. Each path should get an "Open Terminal" button beside it. The data is already loaded server-side through `getPlanDetail()` → `getAssignmentEntry()`.

**Config field**: New `terminalApp` optional string field in `configSchema.ts` (alongside `terminalInput`). Defaults to `"WezTerm"` at the point of use. User can set to any macOS app name like `"Terminal"`, `"iTerm"`, etc.

**Server function**: `openTerminalInDirectory(directory: string, terminalApp?: string, deps?)` in `terminal_control.ts`:
1. Validate directory exists using `deps.fileExists`
2. Resolve app name: `terminalApp || 'WezTerm'`
3. On macOS: `open -a <app> <directory>`
4. On other platforms: throw (unsupported)

**Remote command**: New export `openTerminal` in `session_actions.remote.ts` with schema `{ directory: z.string() }`.

**Client integration**: Add `openTerminal(directory: string)` method to `SessionManager` in `session_state.svelte.ts` that calls the remote command.

## Implementation Guide

### Step 1: Add `terminalApp` config field to `configSchema.ts`

Add a new optional string field to the tim config schema alongside the existing `terminalInput` field:

```typescript
terminalApp: z
  .string()
  .optional()
  .describe('Terminal application to use when opening new terminal windows (e.g. "WezTerm", "Terminal", "iTerm"). Defaults to "WezTerm".')
```

Per CLAUDE.md, do NOT use `.default()` in the zod schema. The default of `"WezTerm"` will be applied at the point of use in `terminal_control.ts`.

### Step 2: Add `openTerminalInDirectory` to `terminal_control.ts`

Add a new exported async function following the existing pattern:

```
openTerminalInDirectory(directory: string, terminalApp?: string, deps: TerminalControlDeps = DEFAULT_TERMINAL_CONTROL_DEPS): Promise<void>
```

Implementation:
1. Check if `directory` exists using `deps.fileExists(directory)` — throw if not found
2. Resolve the terminal app name: `const app = terminalApp || 'WezTerm'`
3. On macOS: run `['open', '-a', app, directory]` via `deps.spawnAndLogOutput` with `{ quiet: true }`
4. On other platforms: throw an error (no supported terminal launcher)
5. Check exit code and throw on failure

This is simpler than the existing `focusTerminalPane` — it doesn't need WezTerm CLI integration since `open -a` works for any macOS application including WezTerm.

### Step 3: Add tests for `openTerminalInDirectory` in `terminal_control.test.ts`

Follow the existing test patterns using `createDeps()` with mocked `spawnAndLogOutput`:
- Test happy path with default terminal: spawns `open -a WezTerm <dir>` on macOS
- Test happy path with custom terminal app: spawns `open -a iTerm <dir>`
- Test error: directory doesn't exist → throws
- Test error: non-macOS platform → throws
- Test error: spawn command fails (non-zero exit) → throws with stderr message

### Step 4: Add remote command in `session_actions.remote.ts`

Add a new export:
```typescript
const openTerminalSchema = z.object({
  directory: z.string().min(1),
});

export const openTerminal = command(openTerminalSchema, async ({ directory }) => {
  const { config } = await getServerContext();
  await openTerminalInDirectory(directory, config.terminalApp);
});
```

Import `openTerminalInDirectory` from `$lib/server/terminal_control.js` and `getServerContext` from `$lib/server/init.js`.

### Step 5: Mount `<Toaster />` in root layout

The `svelte-sonner` Toaster component exists at `src/lib/components/ui/sonner/` but isn't mounted yet. Add `<Toaster />` to `src/routes/+layout.svelte` so toast notifications work app-wide. Import from `$lib/components/ui/sonner/index.js`.

### Step 6: Add client method in `session_state.svelte.ts`

Add a method to `SessionManager` (at the end of the class, after `activateTerminalPane`):
```typescript
async openTerminalInDirectory(directory: string): Promise<void> {
  await openTerminal({ directory });
}
```

Import `openTerminal` from `$lib/remote/session_actions.remote.js`. Unlike `activateTerminalPane`, do NOT swallow errors — let them propagate so callers can show toast error messages.

### Step 7: Add "Open Terminal" button to `SessionRow.svelte`

Add a new button next to the existing terminal-activate button. The button should:
- Be visible when `session.sessionInfo.workspacePath` exists
- Use `AppWindow` icon from `@lucide/svelte/icons/app-window`
- Show on hover using the same `opacity-0 group-hover:opacity-100` pattern
- On click: call `sessionManager.openTerminalInDirectory(session.sessionInfo.workspacePath)`, catch errors and show `toast.error('Failed to open terminal')` via `svelte-sonner`
- Use `e.stopPropagation(); e.preventDefault()` to avoid navigating the link
- Add `aria-label="Open new terminal"` and `title="Open new terminal"`

### Step 8: Add "Open Terminal" button to `SessionDetail.svelte`

In the session header (around lines 87-97), add a new button alongside the existing "activate terminal pane" button:
- Visible when `session.sessionInfo.workspacePath` exists (independent of `hasTerminalPane`)
- Use `AppWindow` icon to differentiate from the existing `TerminalIcon` "activate pane" button
- Always visible (not hover-dependent) since SessionDetail header has more space
- On click: call `sessionManager.openTerminalInDirectory(session.sessionInfo.workspacePath)`, catch errors and show `toast.error(...)` via `svelte-sonner`
- Add `aria-label="Open new terminal"` and `title="Open new terminal"`

### Step 9: Add "Open Terminal" button to `PlanDetail.svelte`

In the "Assigned Workspace" section (around line 247-263), add a button next to each workspace path:
- Replace the plain `<div class="truncate">{wsPath}</div>` with a flex row containing the path text and an icon button
- On click: call `sessionManager.openTerminalInDirectory(wsPath)`, catch errors and show `toast.error(...)` via `svelte-sonner`
- Use same `AppWindow` icon for consistency
- Always visible (not hover-only) since the plan detail view has more space

### Step 10: Manual Testing

1. Start the dev server with `bun run dev`
2. Navigate to the sessions tab — hover over a session with a workspace path and verify the new button appears
3. Click the button — verify a new terminal window opens in the correct directory
4. Navigate to a plan that's assigned to a workspace — verify the button appears in the assignment section
5. Click the button — verify terminal opens in workspace directory
6. Test with a session that has no workspace path — verify button is hidden
7. Test with a plan that has no assignment — verify no button appears

## Current Progress
### Current State
- All 9 tasks complete. Feature is fully implemented.
### Completed (So Far)
- Task 1: `terminalApp` config field added to `configSchema.ts` (no `.default()`)
- Task 2: `openTerminalInDirectory()` in `terminal_control.ts` — uses `wezterm start --cwd` for WezTerm, `open -a` for other apps, validates directory via `directoryExists` dep
- Task 3: Tests in `terminal_control.test.ts` covering default WezTerm, lowercase wezterm, custom app, missing dir, non-directory path, unsupported platform, spawn failure
- Task 4: `openTerminal` remote command in `session_actions.remote.ts` with tests
- Task 5: Toaster mounted in root layout
- Task 6: `openTerminalInDirectory` method on SessionManager with tests for correct forwarding and error propagation
- Task 7: Open Terminal button added to SessionRow (hover-visible, with loading state)
- Task 8: Open Terminal button added to SessionDetail (always-visible, with loading state)
- Task 9: Open Terminal button added to PlanDetail workspace paths (with loading state, disables all buttons during any launch)
- README and docs/web-interface.md updated with feature documentation
### Remaining
- None
### Next Iteration Guidance
- N/A — all tasks complete
### Decisions / Changes
- WezTerm uses `wezterm start --cwd <dir>` instead of `open -a WezTerm <dir>` — the latter doesn't reliably create a new window in the target directory
- Added `directoryExists` to `TerminalControlDeps` interface (uses `fs.stat().isDirectory()`) to validate paths are directories, not just files
- Case-insensitive WezTerm matching (`app.toLowerCase() === 'wezterm'`) to handle config variants like `"wezterm"` vs `"WezTerm"`
- All buttons include loading/disabled state to prevent double-clicks
- Error toasts include descriptive error messages from the server
- PlanDetail disables all workspace terminal buttons while any launch is in progress (not just the clicked one)
### Lessons Learned
- `open -a <App> <dir>` on macOS activates the app but doesn't reliably set cwd; use app-specific CLI commands (like `wezterm start --cwd`) when available
- Config values should be compared case-insensitively when they represent app names that users might write in different cases
- Subagents may revert changes made by the orchestrator if they modify the same files — need to verify after each subagent run
- When a button guard blocks all clicks but the disabled attribute is per-item, users see a clickable-looking button that silently does nothing — always align visual state with handler behavior
### Risks / Blockers
- None
