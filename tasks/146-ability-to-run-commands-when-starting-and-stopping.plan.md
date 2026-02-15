---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Ability to run commands when starting and stopping agent command
goal: ""
id: 146
uuid: e37079a4-2cc9-4161-a9a6-b75de7a45756
generatedBy: agent
status: pending
priority: medium
planGeneratedAt: 2026-02-15T09:35:34.117Z
promptsGeneratedAt: 2026-02-15T09:35:34.117Z
createdAt: 2025-11-07T21:16:48.398Z
updatedAt: 2026-02-15T09:35:34.117Z
tasks:
  - title: Restructure signal handling for async cleanup
    done: false
    description: Modify signal handlers in src/tim/tim.ts to support async cleanup.
      Instead of calling process.exit() immediately in SIGINT/SIGTERM/SIGHUP
      handlers, have them set a shutting-down flag and run synchronous cleanup
      only. The currently-running subprocess will also receive SIGINT and
      terminate, causing the await to resolve and control flow to reach the
      finally blocks in timAgent(). Add executeAllAsync() method to
      CleanupRegistry in src/common/cleanup_registry.ts that supports async
      handlers alongside the existing synchronous executeAll(). Update
      timAgent() to check the shutdown flag in its execution loop and break out
      if set. Write tests verifying that async cleanup runs on signal-based
      exits.
  - title: Define lifecycle config schema
    done: false
    description: "In src/tim/configSchema.ts, add lifecycleCommandSchema with
      fields: title (string), command (string), mode (enum run|daemon,
      optional), check (string, optional), shutdown (string, optional),
      workingDirectory (string, optional), env (record, optional), allowFailure
      (boolean, optional). Add lifecycle object to timConfigSchema containing
      commands array. Do NOT use .default() in zod schemas. Export
      LifecycleCommand type. Regenerate schema/tim-config-schema.json."
  - title: Update config merging for lifecycle
    done: false
    description: "In src/tim/configLoader.ts, add special merge handling for the
      lifecycle key. Since lifecycle is an object containing a commands array, a
      simple shallow merge would replace the array instead of concatenating. Add
      custom merge logic similar to the executors handling at lines 60-86: if
      both configs have lifecycle, concatenate the commands arrays so global
      config commands run first, then repo, then local. Add tests in
      configLoader.test.ts verifying lifecycle config parsing and merging across
      config levels."
  - title: Create LifecycleManager class
    done: false
    description: "Create src/tim/lifecycle.ts with LifecycleManager class.
      Constructor takes lifecycle.commands array and baseDir. Implement
      startup() method: iterate commands in order; for daemon mode with check,
      run check and skip if exit 0; for daemon mode, spawn as child process via
      Bun.spawn and track handle with background stdout/stderr readers; for run
      mode, execute and wait like executePostApplyCommand. check is available on
      any command with shutdown behavior (has shutdown field or is mode:
      daemon). Implement shutdown() method: process in reverse order; for
      skipped commands skip shutdown; for daemons with explicit shutdown run
      that command then kill if still alive; for daemons without shutdown kill
      process (SIGTERM, 5s timeout, then SIGKILL); for run commands with
      shutdown run the shutdown command. Errors during shutdown are logged but
      dont prevent subsequent steps. Implement killDaemons() synchronous method
      for CleanupRegistry fallback."
  - title: Write lifecycle manager tests
    done: false
    description: "Create src/tim/lifecycle.test.ts with comprehensive tests. Startup
      tests: run-and-wait executes in order; daemon spawned and tracked;
      allowFailure behavior; check succeeds on daemon skips startup and
      suppresses shutdown; check succeeds on run-with-shutdown skips both; check
      fails runs normally; check ignored on commands without shutdown behavior.
      Shutdown tests: reverse order; daemon killed (SIGTERM then SIGKILL) when
      no explicit shutdown; daemon with explicit shutdown runs command then
      kills if alive; run with shutdown runs command; skipped commands have
      shutdown suppressed; errors dont block other shutdowns; shutdown runs even
      after startup errors. Integration test with mixed command types."
  - title: Integrate lifecycle into agent command
    done: false
    description: "In src/tim/commands/agent/agent.ts timAgent() function: after
      config loaded and workspace set up (around line 314), create
      LifecycleManager from config.lifecycle?.commands and currentBaseDir. Call
      lifecycleManager.startup() before execution loop (before line 429).
      Register lifecycleManager.killDaemons() with CleanupRegistry as sync
      fallback. In the finally block (around line 1086), call await
      lifecycleManager.shutdown() before summary collection, log file closing,
      and notifications. If no lifecycle commands configured, skip lifecycle
      manager creation entirely."
  - title: Update README with lifecycle documentation
    done: false
    description: "Document the lifecycle configuration section in README. Include:
      overview of the feature; config schema reference for lifecycle.commands
      with all fields; examples showing managed daemon (dev server), external
      daemon (Docker compose with check), run-and-wait with cleanup, and simple
      run-and-wait; explanation of check command behavior (available on commands
      with shutdown behavior); signal handling behavior (shutdown runs on
      SIGINT/SIGTERM/SIGHUP); config merging behavior (commands concatenated
      across global/repo/local)."
---

We want to be able to define commands that can be run in the project level configuration file. For each command, we should be able to run it in daemon mode and then kill it at the end, or just run it and wait for it to finish. These commands should be run when doing the run command. We should also be able to define commands that run when the run command exits, and this should include on a SIGINT or similar.

We also need some ability for a command to indicate if one of the shutdown commands should run. For example, if the Docker containers that it would start are already started, then it might want to indicate that we should not run the shutdown command that turns them off.

## Expected Behavior/Outcome

When `tim run` (or `tim agent`) is invoked, a new lifecycle hook system runs user-defined commands at two phases:

1. **Startup phase** (before the agent execution loop begins):
   - Commands in `lifecycle.commands` run sequentially in config order.
   - Each command can be `mode: "run"` (default — run and wait) or `mode: "daemon"` (spawned as a managed child process).
   - Daemon commands can optionally specify a `check` command. If check exits 0, the startup command is skipped and its shutdown is suppressed.
   - Any command can have an optional `shutdown` field for cleanup on exit.

2. **Shutdown phase** (after the agent execution loop ends, including on SIGINT/SIGTERM/SIGHUP):
   - Commands are processed in reverse order.
   - For `mode: daemon`: if the command has an explicit `shutdown` field, run that command; otherwise kill the managed child process (SIGTERM, then SIGKILL after timeout).
   - For `mode: run` with `shutdown`: run the shutdown command.
   - Commands whose startup was skipped (due to check) have their shutdown suppressed.
   - Shutdown commands run even if the agent encountered an error.
   - Shutdown commands run on signal-based exits too (async cleanup via restructured signal handling).

### Config Shape

```yaml
lifecycle:
  commands:
    # Managed daemon — spawned as child process, killed on shutdown
    - title: Dev server
      command: node server.js
      mode: daemon

    # External daemon — command starts something externally, explicit shutdown to clean up
    - title: Docker containers
      command: docker compose up -d
      check: docker compose ps --status running | grep -q mycontainer
      shutdown: docker compose down

    # Run-and-wait with cleanup
    - title: Seed test data
      command: bun run seed
      shutdown: bun run seed:reset

    # Simple run-and-wait, no cleanup needed
    - title: Run migrations
      command: bun run migrate
```

### Modes

- **`mode: "run"` (default)**: Runs the command via shell, waits for it to complete. If it fails and `allowFailure` is false, abort startup.
- **`mode: "daemon"`**: Spawns the command as a managed child process. The lifecycle manager tracks the process handle. On shutdown, if no explicit `shutdown` command is provided, the process is killed directly. If `shutdown` is provided, that command is run instead (and the process is also killed if still alive).

### Check Commands

- `check` is available on any command that has a `shutdown` field or is `mode: daemon` (i.e., any command where there's shutdown behavior to suppress).
- If `check` exits 0, the startup command is skipped and the corresponding shutdown is suppressed.
- Use case: avoid starting Docker containers that are already running, and avoid shutting them down on exit.

### States

- **Command states**: `pending` → `skipped` (if check passes) | `running` → `succeeded` | `failed`
- **Daemon process states**: `pending` → `skipped` (if check passes) | `running` → `stopped` (on shutdown)
- **Shutdown states**: `pending` → `skipped` (if startup was skipped) | `running` → `succeeded` | `failed`

## Key Findings

### Product & User Story
As a developer using `tim run`, I want to define commands (e.g., start a dev server, spin up Docker containers, run database migrations) that automatically run before the agent starts working, and corresponding cleanup commands that run when the agent finishes. This avoids manual setup/teardown steps and ensures resources are properly managed even when the agent is interrupted.

### Design & UX Approach
- Configuration is defined in the project-level `tim.yml` config file under a new `lifecycle` key.
- Uses a **unified command list** (`lifecycle.commands`) where each entry has a startup `command` and an optional `shutdown` command. This keeps related startup/shutdown together and avoids the complexity of pairing separate arrays.
- The existing `postApplyCommandSchema` pattern is reused for the command shape (title, command, workingDirectory, env, allowFailure).
- Config merging across global/repo/local configs **concatenates** the `commands` array (global first, then repo, then local), consistent with how `postApplyCommands` already merges.

### Technical Plan & Risks
- **Signal handling restructure**: The current `CleanupRegistry` only supports synchronous handlers, and signal handlers call `process.exit()` immediately. This must be restructured so that SIGINT/SIGTERM/SIGHUP set a flag and let the normal async `finally` blocks run (which includes lifecycle shutdown). This ensures shutdown commands run on all exit paths.
- **Order of operations**: Lifecycle shutdown should run before workspace lock release but after the agent loop finishes.
- **Daemon process management**: Need to track spawned daemon processes and ensure they're killed even on abnormal exit.
- **Error tolerance**: Startup command failures should be configurable (allowFailure). Shutdown commands should always attempt to run regardless of prior failures.

### Pragmatic Effort Estimate
This is a moderate-sized feature. The config schema extension, command execution logic, and daemon process tracking are straightforward given the existing patterns. The main complexity is in restructuring signal handling to support async cleanup.

## Acceptance Criteria

- [ ] User can define `lifecycle.commands` in `tim.yml` with startup commands that run before agent execution.
- [ ] Commands support `mode: "run"` (run and wait) and `mode: "daemon"` (managed child process).
- [ ] Commands can have an optional `shutdown` field for cleanup on exit.
- [ ] Daemon processes without explicit shutdown are automatically killed (SIGTERM then SIGKILL).
- [ ] Daemon processes with explicit `shutdown` run that command instead of killing.
- [ ] Commands with shutdown behavior support a `check` field — if exit 0, startup and shutdown are skipped.
- [ ] Shutdown runs on normal exit, error exit, and signal-based exit (SIGINT/SIGTERM/SIGHUP).
- [ ] Shutdown processes commands in reverse order.
- [ ] Config merging concatenates `lifecycle.commands` across global/repo/local configs.
- [ ] All new code paths are covered by tests.
- [ ] The JSON schema for tim config is updated.

## Dependencies & Constraints

- **Dependencies**: Relies on existing `CleanupRegistry`, `postApplyCommandSchema` pattern, and the signal handler infrastructure in `tim.ts`.
- **Technical Constraints**: Signal handling must be restructured to support async cleanup. Instead of calling `process.exit()` immediately in signal handlers, signals should set a flag and allow the normal async `finally` blocks to run, which then call `process.exit()` at the end. This is a cross-cutting change that affects all signal-based exit paths.

## Implementation Notes

### Recommended Approach
- Add a `lifecycle` config section with a `commands` array using the unified schema.
- Create a `LifecycleManager` class that handles startup execution, daemon tracking, and shutdown orchestration.
- Restructure signal handling in `tim.ts` to support async cleanup: on SIGINT/SIGTERM/SIGHUP, set a flag and let the program flow to its natural `finally` blocks rather than calling `process.exit()` immediately.
- Integrate the lifecycle manager into `timAgent()` in `agent.ts`.
- Reuse patterns from `executePostApplyCommand` in `actions.ts` for command execution.
- For managed daemon processes, use `Bun.spawn` with `stdio: ['ignore', 'pipe', 'pipe']` and track the process handle.

### Potential Gotchas
- Restructuring signal handling is the riskiest part. Need to ensure that SIGINT still interrupts the currently-running claude subprocess (which it will, since signals propagate to child processes), and that the parent process then runs its cleanup before exiting.
- Daemon processes may have child processes that need to be killed with process group signals.
- When signal handling is restructured, existing cleanup registry handlers still need to run, just through the normal async flow rather than synchronous signal handlers.
- The `check` command feature needs to track which commands were skipped to suppress their shutdown.

## Research

### 1. Existing Architecture Overview

The `tim run` command (aliased as `tim agent`) is the primary entry point for automated plan execution. The command flow is:

1. `handleAgentCommand()` in `src/tim/commands/agent/agent.ts` handles plan discovery, config loading, and headless adapter setup.
2. `timAgent()` (same file, line 261) is the core execution function:
   - Loads config (line 278)
   - Sets up workspace and locks (lines 298-311)
   - Builds executor (lines 316-386)
   - Runs execution loop (serial or batch mode, lines 429-1081)
   - Finally block for summary, log file, and notifications (lines 1086-1131)

### 2. Configuration System

**Config files**: `.rmfilter/config/tim.yml` (repo-level), `.rmfilter/config/tim.local.yml` (local override), `~/.config/tim/config.yml` (global).

**Schema definition**: `src/tim/configSchema.ts` defines all config using Zod schemas. Key rules from CLAUDE.md:
- Do NOT use `.default()` in Zod schemas — it breaks config merging.
- Apply defaults in `getDefaultConfig()` or where values are consumed.

**Config merging** (`src/tim/configLoader.ts`):
- `mergeConfigs()` (line 17) handles deep merge for select keys.
- Arrays are concatenated, objects are shallow-merged per key.
- New config keys that are objects or arrays must be added to the `mergeConfigKey()` calls (lines 46-57).
- `lifecycle` contains a `commands` array, so it needs special handling similar to how `executors` is handled — the `commands` array within the object should be concatenated.

**JSON schema**: `schema/tim-config-schema.json` — must be regenerated when the Zod schema changes.

### 3. Existing Command Execution Patterns

**`postApplyCommandSchema`** (configSchema.ts, line 22):
```
{ title, command, workingDirectory?, env?, allowFailure?, hideOutputOnSuccess? }
```

**`executePostApplyCommand()`** (actions.ts, line 22):
- Resolves working directory relative to git root.
- Merges environment variables.
- Uses `Bun.spawn(['sh', '-c', command])` with pipe stdio.
- Buffers output if `hideOutputOnSuccess` is true.
- Returns `true` on success or allowed failure, `false` on failure.

**`postCloneCommands`** (workspaceCreationConfigSchema, configSchema.ts line 83):
- Uses the same `postApplyCommandSchema` shape.
- Executed in `workspace_manager.ts` after workspace creation.

### 4. Signal Handling & Cleanup (Current State)

**Top-level signal handlers** (`src/tim/tim.ts`, lines 1268-1285):
```typescript
process.on('exit', () => cleanupRegistry.executeAll());
process.on('SIGINT', () => { cleanupRegistry.executeAll(); process.exit(130); });
process.on('SIGTERM', () => { cleanupRegistry.executeAll(); process.exit(); });
process.on('SIGHUP', () => { cleanupRegistry.executeAll(); process.exit(); });
```

**CleanupRegistry** (`src/common/cleanup_registry.ts`):
- Singleton pattern with `register(handler) → unregister()`.
- `executeAll()` runs all handlers synchronously, catches errors per handler, clears after execution.
- Handlers must be **synchronous** — no async support.

**Workspace lock cleanup** (`src/tim/workspace/workspace_lock.ts`, lines 224-258):
- Registers its own signal handlers for `exit`, `SIGINT`, `SIGTERM`, `SIGHUP`.
- Synchronously releases workspace locks.

**Problem**: Signal handlers call `process.exit()` immediately, which means async cleanup (like running shutdown commands) can't complete. This must be restructured.

### 5. Process Management

**`src/common/process.ts`**:
- `spawnAndLogOutput()` (line 362): Spawns and waits for output with timeout support.
- `spawnWithStreamingIO()` (line 339): Spawns with stdin pipe for interactive use.
- `logSpawn()` (line 84): Basic spawn with logging.

**Bun.spawn**: Used directly in `actions.ts` for `executePostApplyCommand()`. Supports `stdio` configuration, environment variables, and working directory.

### 6. Key Files That Need Modification

| File | Purpose |
|------|---------|
| `src/tim/configSchema.ts` | Add `lifecycle` config schema |
| `src/tim/configLoader.ts` | Add `lifecycle` to deep merge keys with special array concatenation |
| `src/tim/commands/agent/agent.ts` | Integrate lifecycle startup/shutdown into `timAgent()` |
| `src/tim/tim.ts` | Restructure signal handlers for async cleanup |
| `src/common/cleanup_registry.ts` | Add async cleanup support |
| `schema/tim-config-schema.json` | Regenerate from updated Zod schema |

### 7. New Files to Create

| File | Purpose |
|------|---------|
| `src/tim/lifecycle.ts` | `LifecycleManager` class with startup/shutdown/daemon tracking |
| `src/tim/lifecycle.test.ts` | Tests for lifecycle command execution |

## Implementation Guide

### Step 1: Restructure Signal Handling for Async Cleanup

This is the foundational change that enables lifecycle shutdown commands to run on signal-based exits.

**Current behavior** (`src/tim/tim.ts`, lines 1268-1285): Signal handlers call `cleanupRegistry.executeAll()` synchronously and then `process.exit()`.

**New behavior**: Signal handlers should set a flag indicating the process should exit, and let the currently-running async code flow to its natural `finally` blocks. The `finally` blocks (in `timAgent()` and elsewhere) will check the flag and run async cleanup (including lifecycle shutdown) before calling `process.exit()`.

Specific changes:

1. **Add `executeAllAsync()` to `CleanupRegistry`** (`src/common/cleanup_registry.ts`): Add a new method that supports both sync and async handlers. The existing `executeAll()` remains for backwards compatibility (e.g., the `exit` handler which must be sync). Register lifecycle shutdown as an async handler.

2. **Change signal handlers in `tim.ts`**: Instead of `process.exit()` in SIGINT/SIGTERM/SIGHUP handlers, have them:
   - Run synchronous cleanup (daemon killing via `cleanupRegistry.executeAll()`)
   - Set a global "shutting down" flag
   - The currently running claude subprocess will receive SIGINT too and terminate, causing the `await` in the agent loop to resolve/reject
   - The `finally` blocks in `timAgent()` then run, which includes async lifecycle shutdown
   - After the `finally` blocks complete, `process.exit()` is called

3. **Ensure the agent command respects the shutdown flag**: In `timAgent()`, the execution loop should check the shutdown flag and break out if set. The `finally` block should always run lifecycle shutdown.

**Key insight**: When SIGINT is sent to the parent process, child processes (the claude subprocess) also receive it. So the subprocess will terminate, the `await` on its result will resolve, and control flow naturally reaches the `finally` block in `timAgent()`. The signal handler just needs to ensure the process eventually exits — it doesn't need to run all cleanup synchronously.

**Testing**: The existing signal handling tests (if any) should be verified, and new tests should confirm that async cleanup runs on signal-based exits.

### Step 2: Define the Lifecycle Config Schema

In `src/tim/configSchema.ts`, add a new schema for the unified lifecycle command:

```typescript
const lifecycleCommandSchema = z.object({
  title: z.string(),
  command: z.string(),
  mode: z.enum(['run', 'daemon']).optional(),  // defaults to 'run'
  check: z.string().optional(),  // meaningful for commands with shutdown behavior
  shutdown: z.string().optional(),  // explicit shutdown command
  workingDirectory: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  allowFailure: z.boolean().optional(),
});
```

Add `lifecycle` to the main `timConfigSchema`:
```typescript
lifecycle: z.object({
  commands: z.array(lifecycleCommandSchema).optional(),
}).optional(),
```

**Important**: Do NOT use `.default()` in the Zod schemas. Keep them all `.optional()`.

Export the `LifecycleCommand` type from the schema for use in the lifecycle manager.

### Step 3: Update Config Merging

In `src/tim/configLoader.ts`, add special handling for `lifecycle`. Since `lifecycle` is an object containing the `commands` array, a simple shallow merge would replace the array instead of concatenating it.

Add custom merge logic (similar to the `executors` handling at lines 60-86): if both configs have `lifecycle`, concatenate the `commands` arrays. This ensures global config commands run first, then repo, then local.

### Step 4: Create the LifecycleManager

Create `src/tim/lifecycle.ts` with a `LifecycleManager` class.

**Constructor**: Takes the `lifecycle.commands` array and a `baseDir` (working directory for command execution).

**`startup()` method** (async):
1. Iterate through commands in order.
2. For each command:
   a. If `check` is defined and the command has shutdown behavior (has `shutdown` field or is `mode: daemon`): run the check command via shell. If exit code 0, mark as `skipped`, log, and continue.
   b. If `mode === 'daemon'`: Spawn the command as a managed child process using `Bun.spawn(['sh', '-c', command], { ... })`. Track the process handle. Start background readers for stdout/stderr that log output.
   c. If `mode === 'run'` (default): Execute using a pattern similar to `executePostApplyCommand()`. Wait for completion. If it fails and `allowFailure` is not true, throw an error.
3. Track the state of each command (skipped/succeeded/failed) for shutdown decisions.

**`shutdown()` method** (async):
1. Process commands in reverse order.
2. For each command:
   a. If the command was skipped during startup, skip shutdown too. Log.
   b. If `mode === 'daemon'` and the process is still alive:
      - If explicit `shutdown` command: run it via shell, then kill the process if still alive.
      - If no `shutdown` command: kill the process (SIGTERM, wait up to 5 seconds, then SIGKILL).
   c. If `mode === 'run'` and has `shutdown` command: run the shutdown command.
3. Errors during any shutdown step are logged but do not prevent subsequent steps.

**`killDaemons()` method** (synchronous):
- For the CleanupRegistry: synchronously sends SIGTERM to all tracked daemon processes.
- This is a best-effort fallback for cases where the async shutdown path can't run.

**Daemon process tracking**:
- Store `Subprocess` handles from `Bun.spawn()` in an array.
- Track whether each daemon is still alive (check `proc.exitCode !== null` or similar).
- When killing, use `proc.kill('SIGTERM')`, then after timeout `proc.kill('SIGKILL')`.

### Step 5: Integrate into Agent Command

In `src/tim/commands/agent/agent.ts`, in the `timAgent()` function:

1. After config is loaded and workspace is set up (around line 314), create a `LifecycleManager` instance from `config.lifecycle?.commands` and `currentBaseDir`.
2. Call `lifecycleManager.startup()` before the execution loop begins (before line 429). If startup fails (and `allowFailure` is not set), let the error propagate — the `finally` block will still run shutdown.
3. Register `lifecycleManager.killDaemons()` with the `CleanupRegistry` as a synchronous fallback.
4. In the `finally` block (around line 1086), call `await lifecycleManager.shutdown()`. This runs before summary collection, log file closing, and notifications.

### Step 6: Update JSON Schema

Run the JSON schema generation command to update `schema/tim-config-schema.json` with the new `lifecycle` section. The project has a script or process for this — check `package.json` for a `schema` or `generate-schema` script, or generate manually.

### Step 7: Write Tests

Create `src/tim/lifecycle.test.ts` with tests covering:

**Startup tests**:
- Run-and-wait commands execute in order and complete before returning.
- Daemon commands are spawned and tracked.
- `allowFailure` on run commands: failure is tolerated when set, throws when not.
- Check command that succeeds on daemon: startup command is skipped, shutdown suppressed.
- Check command that succeeds on run with shutdown: startup and shutdown both skipped.
- Check command that fails: startup command runs normally.
- Check is ignored on commands without shutdown behavior (no `shutdown` field and not `mode: daemon`).

**Shutdown tests**:
- Shutdown commands run in reverse order.
- Daemon processes are killed (SIGTERM then SIGKILL) when no explicit shutdown.
- Daemon processes with explicit shutdown: shutdown command runs, then process is killed if still alive.
- Run commands with shutdown: shutdown command runs.
- Skipped commands (via check): shutdown is suppressed.
- Shutdown errors don't prevent other shutdowns from running.
- Shutdown runs even when startup had errors.

**Integration tests**:
- Full lifecycle (startup → shutdown) with mixed command types.
- Signal-based shutdown (harder to test, may need to be manual).

Also add config schema tests in `src/tim/configLoader.test.ts`:
- Lifecycle config parses correctly.
- Config merging concatenates `lifecycle.commands` across config levels.

### Step 8: Update README

Document the new `lifecycle` configuration section in the README with:
- Overview of the feature.
- Config schema reference.
- Examples: managed daemon (dev server), external daemon (Docker), run-and-wait with cleanup, simple run-and-wait.
- Explanation of `check` command behavior.
- Signal handling behavior.

### Manual Testing Steps

1. Create a `tim.yml` with lifecycle commands:
   ```yaml
   lifecycle:
     commands:
       - title: Dev server
         command: "python3 -m http.server 8080"
         mode: daemon
       - title: Seed data
         command: "echo 'seeding...'"
         shutdown: "echo 'cleaning up seed data...'"
   ```
2. Run `tim run` and verify startup commands execute (dev server starts, seed runs).
3. Let the agent complete and verify shutdown runs (seed cleanup, dev server killed).
4. Run `tim run` and Ctrl+C — verify dev server is killed and shutdown commands run.
5. Add a `check` command to a daemon entry that succeeds — verify startup and shutdown are skipped.
