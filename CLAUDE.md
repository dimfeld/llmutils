## Project Configuration

- **Language**: TypeScript
- **Package Manager**: bun
- **Add-ons**: prettier, eslint, vitest, sveltekit-adapter, devtools-json, tailwindcss

---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
# Install dependencies
bun install

# Type checking
bun run check
bun run check-web

# Linting
bun run lint

# Code formatting
bun run format

# Run tests
bun run test
bun run test-cli path/to/specific/test.ts
bun run test-web src/lib/server/session_manager.test.ts
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
  - CRUD modules: `project.ts`, `assignment.ts`, `permission.ts`, `workspace.ts`, `workspace_lock.ts`, `plan.ts`
  - Plan sync: `plan_sync.ts` bridges plan files and DB CRUD with lazy-cached project context; `syncPlanToDb()` is called after every `writePlanFile()`, `syncAllPlansToDb()` handles bulk sync with optional prune
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
- Executor system in `executors/` for different LLM integration approaches. The two main executors are claude_code and codex_cli. The others are not used much anymore.
- **Automatic Parent-Child Relationship Maintenance**: All commands (`add`, `set`, `validate`) work together to ensure bidirectional consistency in the dependency graph, automatically updating parent plans when child relationships are created, modified, or removed

3. **Web interface** (`src/lib/`, `src/routes/`): SvelteKit-based plans browser and real-time sessions monitor (see `docs/web-interface.md` for conventions and gotchas)
   - Server initialization: `src/lib/server/init.ts` provides lazy-init singleton via `getServerContext()` (async) returning `{ config, gitRoot, tasksDir, db, projectId }`. Syncs plan files to DB on first access.
   - Sessions infrastructure: WebSocket server (`src/lib/server/ws_server.ts`) on port 8123 accepts agent connections; session manager (`src/lib/server/session_manager.ts`) tracks sessions and categorizes messages; session context singleton (`src/lib/server/session_context.ts`) survives HMR; started from `src/hooks.server.ts` init function
   - SSE streaming: `src/routes/api/sessions/events/+server.ts` streams session events to browser; action routes under `src/routes/api/sessions/[connectionId]/` for respond, input, dismiss; shared helpers in `src/lib/server/session_routes.ts`
   - DB query helpers: `src/lib/server/db_queries.ts` provides web-specific enriched queries (`getProjectsWithMetadata`, `getPlansForProject`, `getPlanDetail`, `getWorkspacesForProject`) with computed display statuses (`blocked`, `recently_done`) derived from dependency resolution
   - Server-only constraint: All DB imports must be in `$lib/server/` or `+page.server.ts` files — bun:sqlite cannot be imported client-side
   - Uses `$tim` and `$common` aliases (configured in `svelte.config.js`) to import from the CLI codebase
   - Route structure: `/projects/[projectId]/{tab}` where `projectId` is a numeric ID or `all`, and tab is `sessions`, `active`, or `plans`
   - Root layout (`src/routes/+layout.svelte`): app shell with dark header bar and `TabNav` component; root `+layout.server.ts` loads project list via `getProjectsWithMetadata()`
   - Project-scoped layout (`src/routes/projects/[projectId]/`): validates projectId (redirects invalid IDs to `/projects/all/{tab}`), renders `ProjectSidebar` + content area; uses `await parent()` to share data from root layout
   - `TabNav` reads `$page.params.projectId` as source of truth for building tab URLs
   - Cookie-based project persistence: `src/lib/stores/project.svelte.ts` has helpers (`setLastProjectId`, `getLastProjectId`, `projectUrl`) for remembering the last-selected project; cookie is httpOnly (server-read only)
   - Home page (`/`) redirects to `/projects/{lastProjectId}/sessions` via server-side redirect, falling back to `/projects/all/sessions`
   - Plan detail route: `/projects/[projectId]/plans/[planId]` sub-route loads plan detail server-side; redirects to owning project if accessed under wrong projectId
   - Active Work route: `/projects/[projectId]/active` with nested `[planId]` sub-route; split-pane layout with workspaces + active plans list on left, plan detail on right (see `docs/web-interface.md` for details)
   - Components in `src/lib/components/`: `TabNav.svelte`, `ProjectSidebar.svelte`, `PlansList.svelte`, `PlanRow.svelte`, `PlanDetail.svelte`, `FilterChips.svelte`, `StatusBadge.svelte`, `PriorityBadge.svelte`, `WorkspaceBadge.svelte`, `WorkspaceRow.svelte`, `ActivePlanRow.svelte`, `SessionList.svelte`, `SessionRow.svelte`, `SessionDetail.svelte`, `SessionMessage.svelte`, `PromptRenderer.svelte`, `MessageInput.svelte`
   - Session store: `src/lib/stores/session_state.svelte.ts` manages SSE connection and reactive session state; SSE event application logic extracted to `src/lib/stores/session_state_events.ts` for testability; `src/lib/utils/session_colors.ts` defines category color mapping
   - Plans browser helpers: `src/lib/server/plans_browser.ts` abstraction layer between route handlers and `db_queries.ts`; includes `getActiveWorkData()` for the Active Work tab
   - Shared utilities: `src/lib/utils/time.ts` provides `formatRelativeTime()` for human-readable relative timestamps

There are other directories as well but they are mostly inactive.

## Configuration

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

- See `docs/refactoring.md` for the repository refactoring guidance.

## Personal Workflow Notes

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

- TypeScript exhaustive switch statements (with `never` in the default case) only error at compile time. At runtime, unknown values fall through and return `undefined` silently. If runtime safety matters, add a `default` case that throws or returns a fallback — a try/catch around the calling code won't help.

- Registering custom `SIGTERM`/`SIGINT` handlers suppresses Node's default termination behavior. You must call `process.exit()` explicitly in the handler or the process will hang.
