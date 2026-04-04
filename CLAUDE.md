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
```

Use `bun run test` for repository test runs. Do not use `bun test` directly since it runs the wrong test runner.

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
   - Cleanup registry (`cleanup_registry.ts`): Singleton `CleanupRegistry` with `register()` → unregister pattern, synchronous `executeAll()` for signal/exit handlers, and async-aware `executeAllAsync()` for graceful shutdown paths. Handlers can be sync or async.

- Terminal interaction (`terminal.ts`)
- Prompt transport (`common/input.ts` + structured messages): `prompt_request.promptConfig` supports optional `header` and `question` fields for richer GUI rendering in addition to `message`
- Config path utilities (`config_paths.ts`) with `getTimConfigRoot()` for XDG-aware config directory resolution and `getTimCacheDir()` for XDG-aware cache directory (`~/.cache/tim/`)
- Input pause registry (`input_pause_registry.ts`): `PausableInputSource` interface and getter/setter for coordinating stdin between terminal input readers and inquirer prompts without coupling `common` to feature modules
- Prefix selection prompt (`prefix_prompt.ts`): shared custom prompt + `runPrefixPrompt()` used by permissions flows; `prefix_prompt_utils.ts` contains `extractCommandAfterCd()` and `PrefixPromptResult` type, extracted for client-safe reuse in the web UI
- GitHub integration utilities in `github/` subdirectory
  - `identifiers.ts`: `parsePrOrIssueNumber()` for URL parsing, `canonicalizePrUrl()` / `tryCanonicalizePrUrl()` for normalizing PR URLs to `https://github.com/{owner}/{repo}/pull/{number}` (handles `/pulls/` variants, strips query params), `validatePrIdentifier()` for rejecting non-PR URLs, `deduplicatePrUrls()` for canonicalizing and deduplicating a list of PR URLs (used by CLI and API entry points), `categorizePrUrls()` for separating valid PR URLs from invalid entries (non-URLs, issue URLs) used by the web data layer
  - `user.ts`: `getGitHubUsername(options?)` resolves the authenticated GitHub user's login. Checks `options.githubUsername` (from tim config) first, falls back to `octokit.rest.users.getAuthenticated()` with in-memory caching. Returns `null` when `GITHUB_TOKEN` is unset. Failed API calls are cached with a 60s TTL to avoid repeated failures. Lives in `src/common/` so callers must thread `githubUsername` from tim config via the options parameter.
  - `pull_requests.ts`: `fetchOpenPullRequests()` for basic PR listing; `fetchOpenPullRequestsWithReviewers()` extends this with `requested_reviewers` data; `partitionUserRelevantOpenPrs()` splits PRs into authored/reviewing groups by username; `parseOwnerRepoFromRepositoryId()` extracts owner/repo from `github.com__owner__repo` format (validates GitHub host); `constructGitHubRepositoryId(owner, repo)` is the inverse — constructs the `github.com__owner__repo` format for consistent repository ID construction across the codebase
  - `pr_status.ts`: GraphQL queries (`fetchPrFullStatus`, `fetchPrCheckStatus`, `fetchPrMergeableAndReviewDecision`, `fetchPrReviewThreads`) for PR state, checks, reviews, labels, review threads, mergeable status. `fetchPrReviewThreads()` is a paginated query (50 threads/page, 100 comments/page) returning `PrReviewThread[]` with full thread metadata and nested comments. The `fetchPrMergeableAndReviewDecision()` is a lightweight query fetching only `mergeable` and `reviewDecision` fields, used by webhook event handlers for targeted updates.
  - `pr_status_service.ts`: Cache service with `refreshPrStatus()`, `refreshPrCheckStatus()`, `ensurePrStatusFresh()` (stale-while-revalidate), `syncPlanPrLinks()` (atomic plan-PR junction sync, scoped to `source = 'explicit'` rows only — auto-linked rows are independently managed by webhook handlers), and `fetchAndUpdatePrMergeableStatus()` (targeted update of mergeable/review_decision from API, used by webhook handlers). `refreshPrStatus()` fetches review threads in parallel with full status (best-effort — failure preserves cached threads) and accepts optional `{ force: true }` to bypass the freshness gate for full API escape hatch. All entry points canonicalize URLs before persistence or cache lookup.
  - `webhook_client.ts`: `fetchWebhookEvents(serverUrl, token, options?)` fetches events from the webhook server's `/internal/events` endpoint with cursor-based pagination (`afterId`, `limit`). Defines a local `WebhookEvent` interface (does not import from `src/webhooks/`). Reads `TIM_WEBHOOK_SERVER_URL` and `WEBHOOK_INTERNAL_API_TOKEN` from `process.env`. Connection errors (TypeError/ECONNREFUSED) return empty array with warning; HTTP errors (401, 500) are thrown.
  - `webhook_event_handlers.ts`: Event handlers for GitHub webhook payloads. All handlers use monotonic guards to reject out-of-order events. `handlePullRequestEvent()` parses PR metadata, filters by known repos, upserts `pr_status` metadata and labels via `upsertPrStatusMetadata()` (monotonic guard on `pr_updated_at`), updates `requested_reviewers`, auto-links to plans by branch name (inside the main transaction boundary for atomicity, using `source = 'auto'` for `plan_pr` rows), and schedules targeted API fetch for `mergeable`/`review_decision`. Head SHA changes atomically clear check runs only when the metadata update actually applied. `handlePullRequestReviewEvent()` upserts reviews by author (monotonic on `submitted_at`) and schedules targeted API fetch only for review states that affect `review_decision` (APPROVED, CHANGES_REQUESTED, DISMISSED — COMMENTED reviews skip the API call to conserve quota). `handleCheckRunEvent()` upserts check runs by name (monotonic on `completed_at`) and recomputes `check_rollup_state` within a single transaction to prevent stale rollup from concurrent events. All handlers return `HandlerResult` with affected PR URLs and deferred API promises.
  - `webhook_ingest.ts`: Ingestion orchestrator. `ingestWebhookEvents(db)` reads cursor from DB, fetches events from webhook server, inserts into `webhook_log`, dispatches to event handlers by type (`pull_request`, `pull_request_review`, `check_run`), collects deferred API promises and runs them via `Promise.allSettled`, advances cursor, and prunes old log entries. Returns `IngestResult` with counts and affected PR URLs. Returns early if `TIM_WEBHOOK_SERVER_URL` is not set.
  - `project_pr_service.ts`: `refreshProjectPrs(db, projectId, username)` orchestrates project-wide PR refresh. Three-phase architecture: (1) fetch all open PRs with reviewers in a single API call, (2) fetch full status for each PR in parallel (concurrency limit of 5), (3) write all data to DB in a single atomic transaction. Also runs auto-linking: matches PR `head_branch` against plan `branch` fields and creates `plan_pr` junction entries with `source = 'auto'`. Self-authored PRs are excluded from the "Reviewing" group; PENDING reviews don't count for reviewer classification.

2. **tim**: Manages step-by-step project plans with LLM integration, organized by sub-commands
   - Modular command structure in `commands/` directory with separate files per sub-command

- Core functionality: `add.ts`, `agent.ts`, `branch.ts`, `chat.ts`, `generate.ts`, `list.ts`, `next.ts`, `done.ts`, `show.ts`
- Specialized commands: `answer-pr.ts`, `cleanup.ts`, `extract.ts`, `pr.ts`, `validate.ts`, `set.ts`

- Database layer: `db/` directory with SQLite-backed storage for assignments, workspaces, permissions, and project metadata
  - `database.ts`: Singleton connection with WAL mode, foreign keys, and auto-migration
  - `migrations.ts`: Schema versioning with `schema_version` table
  - CRUD modules: `project.ts`, `assignment.ts`, `permission.ts`, `workspace.ts`, `workspace_lock.ts`, `plan.ts`, `pr_status.ts`, `webhook_log.ts`, `project_settings.ts`
  - Plan sync: `plan_sync.ts` provides `syncPlanToDb()` for syncing individual materialized plan files to DB with lazy-cached project context; called by `writePlanFile()` when `skipDb` is false. `tim sync` scans `.tim/plans/` for `*.plan.md` files and syncs them back to DB. DB-first write functions (`writePlanToDb()`, `resolvePlanFromDb()`) are in `plans.ts`. `path_resolver.ts` provides `getLegacyAwareSearchDir()` for legacy-aware plan path resolution where commands still need to work with backing files.
  - `sql_utils.ts`: Shared SQL helpers (e.g. `SQL_NOW_ISO_UTC` for ISO-8601 UTC timestamps)
  - `json_import.ts`: One-time import from legacy JSON files on first DB creation
  - All DB functions are **synchronous** (matching bun:sqlite's native API)
  - All write transactions use `db.transaction().immediate()`
- Workspace management: `workspace.ts` with automated isolation support
- Workspace types and helpers: `workspace_info.ts` provides `WorkspaceInfo`, `WorkspaceMetadataPatch`, `workspaceRowToInfo()`, and workspace lookup helpers. `WorkspaceType` (`'standard' | 'primary' | 'auto'`) is defined in `db/workspace.ts` with integer mapping (0/1/2) for the `workspace_type` DB column
- Workspace locking: `workspace_lock.ts` (`WorkspaceLock` class) uses DB internally while exposing the same static API (`acquireLock`, `releaseLock`, `getLockInfo`, `isLocked`). Signal handlers respect `isDeferSignalExit()` — lock release is deferred during agent shutdown so lifecycle commands complete before another agent can claim the workspace
- Workspace setup: `workspace_setup.ts` provides `setupWorkspace()`, a shared helper used by `agent`, `generate`, and `chat` commands. Encapsulates workspace selection (auto/manual/new), lock acquisition, plan materialization (accepts `planId` option, materializes from DB to `.tim/plans/{planId}.plan.md` instead of copying files), cleanup handler registration, and fallback-to-cwd behavior. Returns `WorkspaceSetupResult` with `branchCreatedDuringSetup` (true when a new branch was created locally, false when reusing an existing branch or not creating branches). When no plan ID is provided and no `--base` branch is specified, branch checkout is skipped and the workspace's current branch is used as-is. For existing workspaces, also handles preparation (dirty check, branch checkout via `--base` option) and runs `workspaceUpdateCommands` from config. After switching, sends updated `session_info` to the headless adapter (via `updateHeadlessSessionInfo()`) so the web UI re-groups the session under the correct workspace. Stale local-only branches (exist locally but not on remote) are deleted and recreated from the base branch rather than reused — gated on `fetchSucceeded` to avoid data loss in offline mode
- Workspace round-trip sync: `workspace_roundtrip.ts` manages pre/post-execution sync for workspace-aware commands. `prepareWorkspaceRoundTrip()` sets up the sync context. `runPreExecutionWorkspaceSync()` wipes materialized plans (via `wipeMaterializedPlans()`) then pulls the branch from origin (skipped for newly created branches) and captures `preExecutionState` for change detection. `runPostExecutionWorkspaceSync()` commits changes, compares against `preExecutionState`, and pushes to origin only if there are actual changes. If the branch was newly created during setup and no changes were made, the local branch is deleted and workspace metadata is cleared. After all sync completes, `wipeMaterializedPlans()` runs again (in a `finally` block) to remove stale plan files. All sync uses origin as intermediary — no direct workspace-to-workspace push. `wipeMaterializedPlans(workspacePath)` deletes all files in `.tim/plans/` except `.gitignore` and `.gitkeep`; failures are logged as warnings but not thrown
- Auto workspace selection: `workspace_auto_selector.ts` handles `--auto-workspace`. When any workspace is tagged `auto`, only auto-typed workspaces are eligible; otherwise all non-primary workspaces are eligible. Also prefers the workspace assigned to the current plan UUID, as long as that workspace is not locked
- Assignment helpers: `assignments/remove_plan_assignment.ts` for shared plan-unassignment logic, `assignments/claim_plan.ts` and `assignments/release_plan.ts` for workspace claim management
- Plan state utilities: `plans/plan_state_utils.ts` centralizes `normalizePlanStatus()` and status classification helpers used across commands. Key helpers: `isPlanComplete()` (done/cancelled/deferred — full lifecycle complete, does NOT include `needs_review`), `isWorkComplete()`/`isWorkCompleteStatus()` (done/cancelled/deferred/needs_review — implementation work finished, plan should not block dependents), `getCompletionStatus(config)` (returns `planAutocompleteStatus` config value, defaulting to `'needs_review'`)
- Parent cascade: `plans/parent_cascade.ts` provides consolidated `checkAndMarkParentDone()` and `markParentInProgress()` using DB queries (`getPlansByParentUuid()`). Accepts `ParentCascadeOptions` with callbacks (`onParentMarkedDone`, `onParentMarkedInProgress`) for logging, allowing CLI and agent to provide different logging. Used by `mark_done.ts`, `set.ts`, and agent `batch_mode.ts`. Treats `needs_review` children as work-complete; uses `getCompletionStatus(config)` for the parent's target status. Skips cascade for already-cancelled or deferred parents
- Plan discovery: `plans/plan_discovery.ts` provides DB-backed `findNextReadyDependencyFromDb()`, `findLatestPlanFromDb()`, `findNextPlanFromDb()` and shared in-memory collection helpers `findNextPlanFromCollection()`, `findNextReadyDependencyFromCollection()` for callers with pre-loaded plans. Uses unified priority scale `{ urgent: 5, high: 4, medium: 3, low: 2, maybe: 1 }`
- Shared utilities captured in purpose-built modules:
  - `plan_display.ts`: Resolves plans (DB-first via `resolvePlanFromDb()`, returns nullable `planPath`) and assembles context summaries for both CLI output and MCP tooling. `resolvePlanFromDb()` throws `PlanNotFoundError` (defined in `plans.ts`); use `isPlanNotFoundError()` from `ensure_plan_in_db.ts` for `instanceof`-based error discrimination
  - `plan_merge.ts`: Handles delimiter-aware plan detail updates and task merging while preserving metadata
  - `plan_materialize.ts`: DB-first plan materialization and sync. `resolveProjectContext()` provides cached `ProjectContext` (projectId, plan row maps, `maxNumericId`) used by plan resolution and ID generation. `materializePlan()` writes a plan from DB to `{repoRoot}/.tim/plans/{planId}.plan.md` with `materializedAs: primary`; `materializeRelatedPlans()` writes parent/children/siblings/dependencies as `.plan.md` files with `materializedAs: reference` (skips existing primary files to preserve user edits); `syncMaterializedPlan()` uses shadow-based diffing to detect which fields were edited in the file, merges with current DB state (preserving DB-side changes to non-edited fields), and re-materializes after sync; `withPlanAutoSync()` wraps DB modifications with file→DB sync before and DB→file re-materialization after (passes `skipRematerialize` to avoid double re-materialization). Shadow infrastructure: `getShadowPlanPath()` returns `.tim/plans/.{planId}.plan.md.shadow`; `generatePlanFileContent()` produces file content without writing to disk; `diffPlanFields()` compares shadow vs file to find changed fields; `mergePlanWithShadow()` overlays only changed fields onto DB state; `readShadowPlanFile()` is a side-effect-free parser (unlike `readPlanFile()` which auto-generates UUIDs). Shadow files are written alongside primary materializations only (not references). When shadow is missing or corrupt, falls back to full-overwrite behavior. `readMaterializedPlanRole()` reads the `materializedAs` frontmatter field without side effects. Path helpers: `getMaterializedPlanPath()`, `getShadowPlanPath()`, `getShadowPlanPathForFile()`, `ensureMaterializeDir()` (creates `.gitignore` with `*.plan.md`). Also exports `TMP_DIR` (`.tim/tmp`) which is included in git exclusion alongside `.tim/plans` and `.tim/logs`
  - `plans_db.ts`: Shared `loadPlansFromDb()` and `planRowToSchemaInput()` for loading plans from SQLite with full field coverage and parent/dependency UUID resolution, used by `list`, `ready`, `show`, MCP tools, plan materialization, and `resolvePlanFromDb()`. Also exports `planRowForTransaction()` (fetches related data and delegates to `planRowToSchemaInput`) and `invertPlanIdToUuidMap()` for commands that resolve plans within DB transactions
  - `ready_plans.ts`: Implements readiness detection, filtering, and sorting used by the CLI and MCP list tools
  - `utils/task_operations.ts`: Centralizes task prompting helpers (interactive input, title search, selection menus) used by both CLI commands and MCP tools for task management
  - `batch_review_cache.ts`: Ephemeral review cache for carrying prior review context between successive `tim review` runs on the same plan/task scope. Stores `BatchReviewCache` (git SHA, `ReviewIssue[]`, timestamp, planId, taskScope) as JSON in `.tim/tmp/`. Key functions: `readBatchReviewCache()`, `writeBatchReviewCache()`, `deleteBatchReviewCache()`, `clearTmpDir()`. Cache filename is keyed on plan ID and sorted 1-based task indexes (e.g. `review-42-1_3_5.json` or `review-42-all.json`). The agent command calls `clearTmpDir()` at startup for a clean slate each session. When a cache file exists, its content is injected into the review prompt as `additionalContext` with instructions to focus on issue resolution and avoid contradicting prior findings
- MCP server (`mcp/generate_mode.ts`) now focuses on registering prompts and delegates tool handlers to the relevant command modules. MCP tools that modify plans (`manage_plan_task`, `update_plan_tasks`, `update_plan_details`) use `withPlanAutoSync()` wrapper for DB-first access with automatic file re-materialization. `create_plan` writes directly to DB with atomic child+parent transactions. `list_ready_plans` is DB-only. `get_plan` uses DB-first `resolvePlan()`. MCP resources (`tim://plans/list`, `tim://plans/ready`) and parent/sibling prompt context use `loadPlansFromDb()` — DB-only plans are fully visible. File paths in MCP output are checked with `fs.existsSync()` before rendering
- Session server infrastructure in `session_server/` for per-process embedded WebSocket servers:
  - `runtime_dir.ts`: Session info file management in `~/.cache/tim/sessions/` (XDG-aware). `SessionInfoFile` interface with sessionId, pid, port, hostname, command, workspacePath, planId, planTitle, planUuid, gitRemote, startedAt, token fields. Provides `getTimSessionDir()`, `writeSessionInfoFile()`, `removeSessionInfoFile()`, `readSessionInfoFile()`, `listSessionInfoFiles()`. Registers `process.on('exit')` cleanup handlers for PID file removal; `removeSessionInfoFile()` auto-unregisters cleanup handlers.
  - `embedded_server.ts`: `startEmbeddedServer(options)` creates a `Bun.serve()` WebSocket server on `/tim-agent`. Options: port (default 0 for random), hostname (default `127.0.0.1`), bearerToken (optional, validated with `crypto.timingSafeEqual`), onConnect/onMessage/onDisconnect callbacks. Returns `EmbeddedServerHandle` with port, stop(), broadcast(), sendTo(), connectedClients. Supports multiple simultaneous client connections.
- Plan file watcher: `plan_file_watcher.ts` provides `watchPlanFile(filePath, onContent)` for monitoring materialized plan files during execution. Uses `fs.watch()` on the parent directory (survives atomic save/rename) with ~300ms debounce. Strips YAML frontmatter and calls `onContent(body)` on change. Returns `{ close(), closeAndFlush() }` handle. Used by `generate.ts`, `agent.ts`, and `chat.ts` to send live plan content updates to the web UI via `HeadlessAdapter.sendPlanContent()`.
- Executor system in `executors/` for different LLM integration approaches. The two main executors are claude_code and codex_cli. The others are not used much anymore.
- Lifecycle command management: `lifecycle.ts` provides `LifecycleManager` class for running user-defined startup/shutdown commands around agent sessions. Supports `run` (run-and-wait) and `daemon` (managed child process) modes, optional `check` commands to skip already-running services, `onlyWorkspaceType` filtering, and reverse-order shutdown with SIGTERM/SIGKILL for daemons. Shutdown commands have a 30s timeout (SHUTDOWN_COMMAND_TIMEOUT_MS) with SIGTERM→SIGKILL escalation; active shutdown command processes are tracked via `activeShutdownProc` so `killDaemons()` can kill them on force-exit. Shutdown commands spawn with `detached: true` for process group cleanup. Configured via `lifecycle.commands` in tim config. Config merging concatenates `lifecycle.commands` arrays across global/repo/local configs.
- Shutdown state management: `shutdown_state.ts` provides `isShuttingDown()`, `setDeferSignalExit()`, and related flags. The `deferSignalExit` opt-in pattern allows the agent command to defer `process.exit()` on signals so async lifecycle shutdown can complete in the `finally` block. Non-agent commands retain immediate exit behavior. Double Ctrl+C force-exits via synchronous `killDaemons()` fallback, which also kills any active shutdown command process.
- **Automatic Parent-Child Relationship Maintenance**: All commands (`add`, `set`, `validate`) work together to ensure bidirectional consistency in the dependency graph, automatically updating parent plans when child relationships are created, modified, or removed

3. **Web interface** (`src/lib/`, `src/routes/`): SvelteKit-based plans browser and real-time sessions monitor (see `docs/web-interface.md` for conventions and gotchas)
   - Server initialization: `src/lib/server/init.ts` provides lazy-init singleton via `getServerContext()` (async) returning `{ config, db }`.
   - Sessions infrastructure: Session discovery client (`src/lib/server/session_discovery.ts`) scans `~/.cache/tim/sessions/` for agent processes and connects to their embedded WebSocket servers; agents no longer connect to tim-gui directly. The WebSocket server (`src/lib/server/ws_server.ts`) on port 8123 is kept for the HTTP notification endpoint and future use; session manager (`src/lib/server/session_manager.ts`) tracks sessions and passes structured messages through to the client (display category computation is client-side in `src/lib/utils/message_formatting.ts`); session context singleton (`src/lib/server/session_context.ts`) survives HMR; started from `src/hooks.server.ts` init function. Webhook poller (`src/lib/server/webhook_poller.ts`) periodically calls `ingestWebhookEvents(db)` when `TIM_WEBHOOK_POLL_INTERVAL` is set (seconds, min 5, max 86400, 15s initial delay); handle stored in session context. Accepts `onPrUpdated` callback to emit `pr:updated` SSE events after ingestion via `emitPrUpdatesForIngestResult()` from `src/lib/server/pr_event_utils.ts`
   - SSE streaming: `src/routes/api/sessions/events/+server.ts` streams session events to browser; action routes under `src/routes/api/sessions/[connectionId]/` for respond, input, dismiss; shared helpers in `src/lib/server/session_routes.ts`
   - DB query helpers: `src/lib/server/db_queries.ts` provides web-specific enriched queries (`getProjectsWithMetadata`, `getPlansForProject`, `getPlanDetail`, `getWorkspacesForProject`, `getWorkspaceDetail`) with computed display statuses (`blocked`, `recently_done`) derived from dependency resolution
   - Server-only constraint: All DB imports must be in `$lib/server/` or `+page.server.ts` files — bun:sqlite cannot be imported client-side
   - Uses `$tim` and `$common` aliases (configured in `svelte.config.js`) to import from the CLI codebase
   - Route structure: `/projects/[projectId]/{tab}` where `projectId` is a numeric ID or `all`, and tab is `sessions`, `active`, `plans`, or `settings` (settings hidden for `all` pseudo-project)
   - Root layout (`src/routes/+layout.svelte`): app shell with dark header bar and `TabNav` component; root `+layout.server.ts` loads project list via `getProjectsWithMetadata()`
   - Project-scoped layout (`src/routes/projects/[projectId]/`): validates projectId (redirects invalid IDs to `/projects/all/{tab}`), renders `ProjectSidebar` + content area; uses `await parent()` to share data from root layout
   - `TabNav` reads `$page.params.projectId` as source of truth for building tab URLs
   - Cookie-based project persistence: `src/lib/stores/project.svelte.ts` has helpers (`setLastProjectId`, `getLastProjectId`, `projectUrl`) for remembering the last-selected project; cookie is httpOnly (server-read only)
   - Home page (`/`) redirects to `/projects/{lastProjectId}/sessions` via server-side redirect, falling back to `/projects/all/sessions`
   - Plan detail route: `/projects/[projectId]/plans/[planId]` sub-route loads plan detail server-side; redirects to owning project if accessed under wrong projectId
   - Active Work route: `/projects/[projectId]/active` with nested `[planId]` and `workspace/[workspaceId]` sub-routes; split-pane layout with workspaces + active plans list on left, plan/workspace detail on right (see `docs/web-interface.md` for details)
   - Session store: `src/lib/stores/session_state.svelte.ts` manages SSE connection and reactive session state; SSE event application logic extracted to `src/lib/stores/session_state_events.ts` for testability; `initialized` flag tracks whether initial SSE sync is complete (gated on `session:sync-complete` event, reset on reconnect); per-project session memory via `lastSelectedSessionIds` SvelteMap (keyed by route projectId) enables returning to the last-viewed session when clicking the Sessions tab; session grouping utilities (`getSessionGroupKey`, `getSessionGroupLabel`) extracted to `src/lib/stores/session_group_utils.ts` as a plain TS module for testability; `src/lib/utils/session_colors.ts` defines category color mapping
   - Plan actions: `src/lib/remote/plan_actions.remote.ts` provides `startGenerate`, `startAgent`, and `startChat` remote commands; `src/lib/server/plan_actions.ts` handles detached process spawning; `src/lib/server/launch_lock.ts` provides per-plan launch locks to prevent duplicate spawns before WebSocket session registration (cleared by `session:update` event or 30s timeout)
   - Workspace actions: `src/lib/remote/workspace_actions.remote.ts` provides `lockWorkspace` and `unlockWorkspace` commands for managing workspace locks from the web UI
   - Project settings: `src/lib/remote/project_settings.remote.ts` provides `updateProjectSetting` command; validates setting names against a `settingValueSchemas` registry. Settings route at `/projects/[projectId]/settings` with featured toggle
   - Review issue actions: `src/lib/remote/review_issue_actions.remote.ts` provides `removeReviewIssue`, `convertReviewIssueToTask`, and `clearReviewIssues` commands for managing review issues from the web UI. `convertReviewIssueToTask` uses `createTaskFromIssue` from `$tim/commands/review.ts` and sets plan status to `in_progress`
   - Plans browser helpers: `src/lib/server/plans_browser.ts` abstraction layer between route handlers and `db_queries.ts`; includes `getActiveWorkData()` for the Active Work tab
   - Shared utilities: `src/lib/utils/time.ts` provides `formatRelativeTime()` for human-readable relative timestamps; `src/lib/utils/keyboard_nav.ts` provides `isListNavEvent()`, `getAdjacentItem()`, and `scrollListItemIntoView()` for Alt+Arrow keyboard navigation across list views; `src/lib/utils/keyboard_shortcuts.ts` provides `isTypingTarget()` and `handleGlobalShortcuts()` for global keyboard shortcuts (Ctrl+/ search focus, Ctrl+1/2/3 tab navigation) wired into the root layout; `src/lib/utils/message_formatting.ts` provides client-side `getDisplayCategory()` and `formatStructuredMessage()` for computing display categories and formatting structured messages that were passed through from the server; `src/lib/utils/session_export.ts` provides `exportSessionAsMarkdown()`, `formatMessageAsMarkdown()`, `formatSessionHeader()`, and `generateExportFilename()` for session transcript export as markdown (used by SessionDetail copy/download buttons); `src/lib/utils/pr_update_events.ts` provides `hasRelevantPrUpdate()` and `shouldRefreshProjectPrs()` for client-side overlap detection when handling `pr:updated` SSE events
   - PR event utilities: `src/lib/server/pr_event_utils.ts` provides `getProjectIdsForPrUrls()` (derives project IDs from canonical PR URLs via repository ID lookup) and `emitPrUpdatesForIngestResult()` (combines project ID derivation with `sessionManager.emitPrUpdate()`, guarded by `hasPrUpdateListeners()`). Used by webhook poller callback and manual refresh commands
   - PWA support: `src/service-worker.ts` (cache-first for static assets, network-only for API/SSE), `static/manifest.webmanifest`, PWA meta tags in `src/app.html`, service worker registration in root layout `onMount`, app badge attention indicator via `src/lib/utils/pwa_badge.ts` and `SessionManager.needsAttention` derived state

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
- When you finish a change, run the tests using `bun run test` and then fix any failures you find
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
