# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
# Install dependencies
bun install

# Type checking
bun run check

# Linting
bun run lint

# Code formatting
bun run format

# Install globally for development
bun run dev-install

# Run tests
bun test
bun test path/to/specific/test.ts
```

## Repository Structure

This repository contains command-line utilities for managing context with chat-oriented programming and applying edits from language models. The codebase has been organized for enhanced modularity and maintainability, with shared utilities consolidated into `src/common/` and feature modules structured for minimal inter-dependency coupling. The key commands are:

- `rmfilter`: Analyzes import trees to gather related files, adds instructions, and prepares context for LLMs
- `rmfind`: Finds relevant files to use with rmfilter
- `tim`: Generates and manages step-by-step project plans using LLMs (organized with separate sub-command modules)
- `apply-llm-edits`: Applies LLM-generated edits back to the codebase
- `rmrun`: Sends rmfilter output to an LLM and applies edits
- `rmfix`: Toolkit for fixing LLM-generated code when it doesn't apply cleanly

## Core Architecture

The codebase is organized into several main modules with improved modularity and clear separation of concerns

1. **common**: Centralized shared utilities and infrastructure
   - CLI utilities (`cli.ts`), file system operations (`fs.ts`), Git integration (`git.ts`)
   - Process management (`process.ts`) with `spawnAndLogOutput()` for fire-and-forget execution and `spawnWithStreamingIO()` for processes that need writable stdin during execution

- Terminal interaction (`terminal.ts`)
- Prompt transport (`common/input.ts` + structured messages): `prompt_request.promptConfig` supports optional `header` and `question` fields for richer GUI rendering in addition to `message`
- Clipboard support with OSC52 (`clipboard.ts`, `osc52.ts`)
  - SSH detection (`ssh_detection.ts`) and model factory (`model_factory.ts`)
  - Config path utilities (`config_paths.ts`) with `getTimConfigRoot()` for XDG-aware config directory resolution
  - Input pause registry (`input_pause_registry.ts`): `PausableInputSource` interface and getter/setter for coordinating stdin between terminal input readers and inquirer prompts without coupling `common` to feature modules
  - Prefix selection prompt (`prefix_prompt.ts`): shared custom prompt + `runPrefixPrompt()` used by permissions flows
  - GitHub integration utilities in `github/` subdirectory

2. **tim**: Manages step-by-step project plans with LLM integration, organized by sub-commands
   - Modular command structure in `commands/` directory with separate files per sub-command

- Core functionality: `add.ts`, `agent.ts`, `branch.ts`, `chat.ts`, `generate.ts`, `list.ts`, `next.ts`, `done.ts`
- Specialized commands: `answer-pr.ts`, `cleanup.ts`, `extract.ts`, `split.ts`, `validate.ts`, `set.ts`

- Database layer: `db/` directory with SQLite-backed storage for assignments, workspaces, permissions, and project metadata
  - `database.ts`: Singleton connection with WAL mode, foreign keys, and auto-migration
  - `migrations.ts`: Schema versioning with `schema_version` table
  - CRUD modules: `project.ts`, `assignment.ts`, `permission.ts`, `workspace.ts`, `workspace_lock.ts`
  - `sql_utils.ts`: Shared SQL helpers (e.g. `SQL_NOW_ISO_UTC` for ISO-8601 UTC timestamps)
  - `json_import.ts`: One-time import from legacy JSON files on first DB creation
  - All DB functions are **synchronous** (matching bun:sqlite's native API)
  - All write transactions use `db.transaction().immediate()`
- Workspace management: `workspace.ts` with automated isolation support
- Workspace types and helpers: `workspace_info.ts` provides `WorkspaceInfo`, `WorkspaceMetadataPatch`, `workspaceRowToInfo()`, and workspace lookup helpers
- Workspace locking: `workspace_lock.ts` (`WorkspaceLock` class) uses DB internally while exposing the same static API (`acquireLock`, `releaseLock`, `getLockInfo`, `isLocked`)
- Workspace setup: `workspace_setup.ts` provides `setupWorkspace()`, a shared helper used by both `agent` and `generate` commands. Encapsulates workspace selection (auto/manual/new), lock acquisition, plan file copying, cleanup handler registration, and fallback-to-cwd behavior. For existing workspaces, also handles preparation (dirty check, branch checkout via `--base` option) and runs `workspaceUpdateCommands` from config
- Auto workspace selection: `workspace_auto_selector.ts` can prefer the workspace assigned to the current plan UUID when running `--auto-workspace`, as long as that workspace is not locked
- Assignment helpers: `assignments/remove_plan_assignment.ts` for shared plan-unassignment logic, `assignments/claim_plan.ts` and `assignments/release_plan.ts` for workspace claim management
- Plan state utilities: `plans/plan_state_utils.ts` centralizes `normalizePlanStatus()` and status classification helpers used across commands
- Shared utilities captured in purpose-built modules:
  - `plan_display.ts`: Resolves plans and assembles context summaries for both CLI output and MCP tooling
  - `plan_merge.ts`: Handles delimiter-aware plan detail updates and task merging while preserving metadata
  - `ready_plans.ts`: Implements readiness detection, filtering, and sorting used by the CLI and MCP list tools
  - `utils/task_operations.ts`: Centralizes task prompting helpers (interactive input, title search, selection menus) used by both CLI commands and MCP tools for task management
- MCP server (`mcp/generate_mode.ts`) now focuses on registering prompts and delegates tool handlers to the relevant command modules
- Executor system in `executors/` for different LLM integration approaches
  - `claude_code/streaming_input.ts`: Builds and sends stream-json messages to Claude Code's stdin; supports both single-prompt (`sendSinglePromptAndWait`) and multi-message (`sendInitialPrompt`, `sendFollowUpMessage`, `closeStdinAndWait`) patterns
  - `claude_code/format.ts`: Parses Claude Code stream-json output, including system lifecycle events like `init`, `task_started`, `task_notification`, `status`, `compact_boundary`, and `rate_limit_event` (rendered as `llm_status` for terminal and tim-gui)
  - `claude_code/terminal_input.ts`: `TerminalInputReader` class for reading interactive user input during agent execution; manages readline lifecycle with pause/resume support for prompt coordination
  - `claude_code/terminal_input_lifecycle.ts`: Shared lifecycle helper (`setupTerminalInput()` / `awaitAndCleanup()`) and `executeWithTerminalInput()` which encapsulates stdin lifecycle branching (terminal input / tunnel or headless forwarding / single prompt); wires user input handlers for both tunnel and headless adapters to forward GUI-originated messages to subprocess stdin; used by both the main executor and `run_claude_subprocess.ts`
- **Automatic Parent-Child Relationship Maintenance**: All commands (`add`, `set`, `validate`) work together to ensure bidirectional consistency in the dependency graph, automatically updating parent plans when child relationships are created, modified, or removed

There are other directories as well but they are mostly inactive.

## Environment Requirements

- **Bun**: Required as the JavaScript runtime
- **ripgrep**: Used for efficient code searching
- **repomix**: Core tool for context preparation
- **fzf**: Used by rmfind for interactive file selection
- **bat**: Used by rmfind and rmrun for syntax highlighting

## Configuration Files

The repository uses several configuration files:

- `.rmfilter/`: Directory for rmfilter preset configurations
- `schema/`: Contains JSON schemas for validating configurations
- Environment variables (via dotenv) for model configuration

When adding new values to configSchema.ts, do not use defaults in the zod schemas. It breaks the ability to merge
the local and main configs together. Instead, apply defaults where the values are read, or set them in
loadEffectiveConfig after merging.

## Testing

The codebase uses Bun's built-in test runner. Tests typically:

- Create temporary test directories with fixture files
- Apply transformations using the utilities
- Verify the output matches expectations

You can enable console logging for debugging tests by running with `TEST_ALLOW_CONSOLE=true` in the environment. Do not
specify `TEST_ALLOW_CONSOLE=false`. It is the default and its presence confuses your Bash tool.

When adding new features, ensure test coverage for:

- Happy path functionality
- Edge cases and error handling
- Different file formats and configurations
- Reuse the cross-interface scenarios in `src/tim/commands/task-management.integration.test.ts` when modifying task management commands or MCP tools; they ensure CLI and MCP behavior stays aligned.

- Don't mock in tests if you can help it.
- Make sure that tests actually test the real code. Don't mock so many things in tests that you aren't testing anything.
- If you do mock modulrs, use ModuleMocker to avoid issues with cross-file mock contamination

## Type Safety

TypeScript is used throughout the codebase with strict type checking:

- Always use proper type annotations for function parameters and return types
- Use type guards and runtime validation where appropriate
- When working with external APIs, ensure proper type safety with validation
- Run `bun run check` before committing to ensure no type errors are present

You can check if compilation works using `bun run check`

## Code Quality Best Practices

- Use prompts from src/common/input.ts for asking questions to the user. These are wrappers around @inquirer/prompts
  that work with the various remote control methods as well as local terminal input.
  Use `promptPrefixSelect()` for Bash command prefix selection so tunnel/headless routing works correctly.

### Testing Strategies

See docs/testing.md for testing strategy

### Refactoring Approach

- **Work bottom-up**: Update utility functions first, then callers to minimize compilation errors
- **Use todo lists**: Break complex changes into trackable items for systematic progress
- **Run type checks frequently**: Catch signature mismatches early in the refactoring process
- **Make incremental commits**: Each commit should focus on a single logical change
- **Consolidate shared utilities early**: When multiple modules need the same helper function, put it in `src/common/` from the start rather than duplicating it across callers and consolidating later
- **Migrate types to their new canonical location first**: When a schema file exports types used by many callers, move types to the new module and update all importers before removing the old file
- **Audit all call sites when unifying behavior**: When making multiple code paths accept the same input (e.g., treating 'cancelled' as a terminal state), check all guards that control entry into the unified function — not just the function body
- **Watch for dead code paths after data model changes**: When migrating from multi-value structures (e.g., arrays) to single-value (e.g., FK), warning/conflict logic that assumed multiple values may become permanently false — remove it rather than leaving dead branches
- **Consider all terminal states**: When a status check uses early-return for terminal states, ensure all terminal states (e.g., both `done` and `cancelled`) are handled to prevent one from being overwritten by another
- **Emit audit/log messages before side effects**: Structured audit messages should be emitted before attempting write operations, not after — otherwise audit trails have gaps when writes fail
- **Pick one authoritative layer for defensive checks**: Redundant defensive checks across multiple layers (e.g., command, executor, utility) create confusion about which layer owns the decision. Resolve the value once and trust it downstream
- **Keep dependency-inversion abstractions minimal**: When introducing a common abstraction to break a dependency cycle (e.g., `common` must not import from `tim`), keep it to just an interface and a getter/setter. The feature module registers itself; the common module only knows the interface
- **Watch for dual state tracking when extracting shared helpers**: If both the inner helper and the outer function track the same state (e.g., a `closed` flag), explicitly synchronize them to avoid misleading guards or double-cleanup
- **Blanket try-catch in shared helpers can change error semantics**: When extracting error-handling logic into a shared helper, explicit throws that were previously unhandled can get caught by a new outer catch, silently converting hard errors into soft fallbacks. Only catch specific expected failure modes (e.g., null returns), not all exceptions
- **Remove dead CLI options instead of leaving no-ops**: When a new system doesn't support a flag, remove the flag rather than keeping it as a no-op. Dead CLI options mislead users into thinking they have an effect
- **Use spread in serialization layers to avoid silently dropping new fields**: When building protocol messages or API payloads from typed objects, use spread (`{ type: 'msg', ...obj }`) rather than manually listing fields. Manual field listing silently drops any newly-added fields. Always check the serialization layer (e.g., adapter handshake) when adding fields to a protocol type, not just the builder
- **Preserve sync/async boundaries when extracting code**: When extracting a function that mixes sync and async operations (e.g., a sync OS call followed by an async shell command), keep the sync/async split in the same place as the original. Moving a sync call into an async context (or vice versa) can cause behavioral regressions like delayed execution or missed error handling
- **Verify locking assumptions when expanding code paths**: When adding operations (e.g., git commands, subprocess execution) to an existing code path, check whether surrounding locking or synchronization still covers the expanded scope. A previously lightweight unlocked phase may become a significant race window after adding heavier operations
- **Re-check assertions after deduplicating logic**: After simplifying duplicate path-computation or state-tracking into a single source, re-check defensive guards for reachability — they may have become dead code that obscures real invariants
- **Avoid control flow that depends on a no-op guard**: If correctness depends on a condition like `x === y` being true (making a branch a no-op), restructure with explicit branches instead. No-op guards are fragile and confuse future readers
- **Keep defaults identical across shared entry points**: When two or more entry points share semantics (e.g., reuse behavior), keep default parameter values identical in both paths. Otherwise users see behavior drift depending on which command they used
- **Pass computed defaults downstream, not raw optionals**: If a function computes an effective default (e.g., `shouldCreateBranch = options.createBranch ?? true`), pass the computed value to callees rather than the raw optional input — otherwise defaults can silently diverge between layers
- **Update docs when reordering operations**: After reordering runtime operations (e.g., swapping lock-then-prepare vs prepare-then-lock), update workflow documentation in the same pass to keep docs in sync with behavior

## Personal Workflow Notes

- When you learn something about the codebase, update CLAUDE.md
- When making a change, always look for related tests that need to be updated or written as well
- When you finish a change, run the tests using `bun test` and then fix any failures you find
- **After adding a feature, update the README to include documentation about the feature**

## Review Notes

- When reviewing PRs, the text in the YAML files are just for planning. Prefer to look at the actual code when analyzing functionality.

- Format the code with `bun run format` after making changes

## Quick Tips

- When printing an error message in a template string in a catch block, use `${err as Error}` to avoid eslint complaining

- Don't use `await import('module')` for regular imports. Just put a normal import at the top of the file

- `Promise.resolve(fn()).catch(...)` does NOT catch synchronous throws from `fn()` — the throw occurs before `Promise.resolve` wraps the result. Use Promise.try(() => fn()) for functions that may throw synchronously.
