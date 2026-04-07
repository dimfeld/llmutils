# llmutils

Command-line utilities for managing context with chat-oriented programming and applying edits from language models.

## Key Commands

- **rmfilter**: Analyzes import trees to gather related files, adds instructions, and prepares context for LLMs
- **rmfind**: Finds relevant files to use with rmfilter
- **tim**: Generates and manages step-by-step project plans using LLMs
- **apply-llm-edits**: Applies LLM-generated edits back to the codebase
- **rmrun**: Sends rmfilter output to an LLM and applies edits
- **rmfix**: Toolkit for fixing LLM-generated code when it doesn't apply cleanly

## Tim Prompt Helpers

`tim prompts` can print reusable prompt text for CLI-driven workflows. For implementation work, use `tim prompts implement <plan>` to load a plan and instruct the agent to implement it while keeping the plan up to date.

## Tim Chat

`tim chat` runs an arbitrary free-form prompt in Claude Code or Codex. Without workspace options, it behaves exactly as before and runs in the current working directory.

When you provide workspace options, `tim chat` participates in the full workspace roundtrip flow used by other tim workspace-aware commands. This includes workspace selection or creation, branch checkout, optional plan association, workspace sync, and optional committing at the end of the session.

Workspace options:

- `-w, --workspace <id>` to use a specific workspace
- `--aw, --auto-workspace` to automatically choose a workspace
- `--nw, --new-workspace` to create a new workspace
- `--base <ref>` to work against a specific branch or ref in the workspace
- `--plan <plan>` to associate the session with a plan and use that plan's workspace metadata
- `--commit` to commit changes after the session finishes
- `--no-workspace-sync` to disable workspace sync for the roundtrip

Examples:

```bash
tim chat --aw --plan 42 "Fix the bug"
tim chat -w my-workspace --base feature-branch "Review code"
tim chat --aw --base main --commit "Clean up imports"
```

## Workspace Management

Use `tim workspace list`, `tim workspace add`, and `tim workspace update` to manage repository workspaces. Workspaces can be `standard`, `primary`, or `auto`: `primary` workspaces receive branch updates from origin after execution, while `auto` workspaces form the preferred pool for `--auto-workspace`.

`tim workspace add [planIdentifier] [--primary | --auto]` sets the initial type for a new workspace, and `tim workspace update <id> [--primary | --no-primary | --auto | --no-auto]` changes it later. When at least one `auto` workspace exists, commands such as `tim agent --auto-workspace` and `tim generate --auto-workspace` only choose from `auto` workspaces; otherwise they fall back to any non-`primary` workspace. See [`docs/multi-workspace-workflow.md`](docs/multi-workspace-workflow.md) for the full workflow.

## Plan Auto-Completion Status

When all tasks in a plan are completed (via `tim done`, agent batch mode, or stub plans), the plan transitions to `needs_review` by default instead of `done`. This gives you a chance to review completed work before marking it fully done. Parent plans also auto-complete to `needs_review` when all children reach a work-complete state (`done`, `needs_review`, `cancelled`, or `deferred`).

Plans in `needs_review` satisfy dependency requirements, so downstream plans are not blocked. Workspace assignments and locks are preserved for `needs_review` plans and only released when the plan reaches `done` (whether via `tim set`, auto-completion with `planAutocompleteStatus: done`, or agent-driven completion).

To skip the review step and go directly to `done`, set the `planAutocompleteStatus` config option:

```yaml
# tim.yml
planAutocompleteStatus: done # default: needs_review
```

Explicit status changes via `tim set <id> --status done` always go directly to `done` regardless of this setting.

When the agent is launched from the web UI (with `--no-terminal-input`), the final review always exits automatically after completion. If the review found issues, they are saved as `reviewIssues` on the plan and the status is set to `needs_review`. The user can then triage review issues from the web UI and re-run the agent to continue.

## Tim Finish

`tim finish <planId>` runs the finalization steps for a completed plan: documentation updates and lessons learned extraction. After running the applicable steps, it sets the plan status to `done`.

The command tracks two fields on the plan: `docsUpdatedAt` (when documentation was last updated) and `lessonsAppliedAt` (when lessons learned were last applied). It only runs whichever steps haven't been done yet, so re-running finish on a partially finalized plan picks up where it left off.

The decision logic:

- **Docs needed**: `docsUpdatedAt` is null AND `updateDocs.mode` is not `never`
- **Lessons needed**: `lessonsAppliedAt` is null AND `applyLessons` is true
- If either step is needed, the command sets up a workspace and headless adapter (like `tim agent`)
- If neither step is needed, it skips workspace/headless setup and just transitions the status to `done`

```bash
tim finish 42                              # Finish plan 42
tim finish 42 --auto-workspace             # Use auto-workspace selection
tim finish 42 --executor claude-code       # Specify executor
tim finish 42 --apply-lessons              # Force-enable lessons
```

In the web UI, "Finish" is the primary action button for `needs_review` plans. For `done` plans with pending finalization work (docs or lessons not yet run), "Finish" appears as a secondary action in the dropdown menu. If no executor work is needed, clicking "Finish" instantly transitions the plan to `done` without spawning a process.

### Manual Mode

The `updateDocs.mode` config option accepts a `manual` value. When set to `manual`, the agent command skips both documentation updates and lessons learned entirely, leaving them for the `finish` command. This is useful when you want to defer finalization to a separate step rather than running it at the end of each agent session.

```yaml
# tim.yml
updateDocs:
  mode: manual # defer docs and lessons to `tim finish`
```

The `manual` mode overrides `applyLessons` in the agent context — both docs and lessons are skipped. The `applyLessons` setting still controls whether lessons run during `tim finish`.

## PR Status Monitoring

`tim pr` is a subcommand namespace for GitHub PR operations:

- `tim pr status [planId]` — Fetch and display PR status for a plan (checks, reviews, merge readiness) with color-coded terminal output. Resolves the plan from a positional argument or the current workspace plan (walks parent directories to find the workspace root). When `TIM_WEBHOOK_SERVER_URL` is set, ingests webhook events first (webhook-first mode); use `--force-refresh` to bypass webhooks and fetch directly from the GitHub API.
- `tim pr link <planId> <prUrl>` — Link a PR to a plan. Validates the PR exists on GitHub, rejects non-PR URLs (e.g. issue URLs), and canonicalizes the URL before updating the plan file.
- `tim pr unlink <planId> <prUrl>` — Remove a PR link from a plan.
- `tim pr description <planFile>` — Generate a PR description from a plan (migrated from the former `tim pr-description` command, which remains as a hidden alias for backwards compatibility).

PR status data (check runs, reviews, labels, merge state) is cached in the SQLite database and surfaced in the web interface. When `TIM_WEBHOOK_SERVER_URL` is configured, both the CLI and web UI use webhook-first refresh (ingesting from the webhook server before displaying data). When not configured, the CLI refreshes directly from GitHub and the web UI uses stale-while-revalidate caching. Requires `GITHUB_TOKEN` environment variable for direct GitHub API access.

### Webhook-Based PR Updates

When connected to the GitHub Webhook Receiver (see below), tim can ingest PR status updates incrementally from webhook events instead of polling the GitHub API directly. This is the preferred approach as it's faster and avoids API rate limits.

Set `TIM_WEBHOOK_SERVER_URL` to the webhook receiver's base URL (e.g., `http://localhost:8080`) and ensure `WEBHOOK_INTERNAL_API_TOKEN` is set to the same token used by the receiver.

Set `TIM_WEBHOOK_POLL_INTERVAL` to enable periodic webhook ingestion in the web server. The value is in seconds, values below `5` are clamped to `5`, polling starts after a `15` second initial delay, and it only runs when both `TIM_WEBHOOK_SERVER_URL` and `WEBHOOK_INTERNAL_API_TOKEN` are also configured.

Supported webhook event types:

- **`pull_request`**: Creates/updates PR status, labels, requested reviewers. Auto-links PRs to plans by branch name.
- **`pull_request_review`**: Updates review state per author.
- **`check_run`**: Updates individual check runs and recomputes the check rollup state.

Fields not available in webhooks (`mergeable`, `review_decision`) are fetched via targeted lightweight API calls triggered by relevant events (only for review states that affect `review_decision`: APPROVED, CHANGES_REQUESTED, DISMISSED). Events for repositories not associated with any tim project are logged but not applied.

**Known limitation**: In webhook mode, the project-level refresh does not run the full `refreshProjectPrsService()` cleanup, so PRs that were closed without a webhook event (e.g., due to webhook server downtime) won't be detected as stale until a manual "Full Refresh from GitHub API" is triggered from the web UI or CLI (`--force-refresh`). Full refresh is available at both the project level and the individual plan level.

### Project-Wide PR View

The web interface supports a project-wide PR view that shows all open PRs for a project's GitHub repository that are relevant to the authenticated user (authored or reviewing). PRs are automatically linked to plans based on branch name matching. The GitHub username is resolved from the `githubUsername` config setting or via the GitHub API (cached in-memory).

```yaml
# tim.yml
githubUsername: your-github-username # optional, avoids an API call
```

### Project Settings

The web interface includes a per-project Settings tab at `/projects/[projectId]/settings` for configuring project-level preferences stored in the database. The settings tab is not shown for the "all projects" view.

Available settings:

- **Featured** (default: on): Controls whether the project appears in the main sidebar list or is grouped in a collapsed "Other Projects" section at the bottom.

### GitHub Webhook Receiver (separate ingress service)

This repository includes a standalone Bun + SQLite webhook receiver at `src/webhooks/server.ts` that can run as a small internet-facing ingress service while keeping the main tim web app private.

Start it with:

```bash
bun run webhook-receiver
```

Required environment variables:

- `GITHUB_WEBHOOK_SECRET`: webhook secret used to validate `X-Hub-Signature-256`
- `WEBHOOK_INTERNAL_API_TOKEN`: bearer token required for all non-public polling/ack routes

Optional environment variables:

- `WEBHOOK_RECEIVER_PORT` (default `8080`)
- `WEBHOOK_RECEIVER_HOST` (default `0.0.0.0`)
- `WEBHOOK_DB_PATH` (default `~/.cache/tim/webhook-receiver.sqlite`)
- `WEBHOOK_REQUIRE_SECURE_INTERNAL_ROUTES` (default `true`)

Routes:

- `POST /github/webhook` (public): validates GitHub signature and stores deliveries idempotently by `X-GitHub-Delivery`
- `GET /internal/events` (protected): bearer auth + secure transport required; supports `afterId`, `limit`, `includeAcked`
- `POST /internal/events/ack` (protected): bearer auth + secure transport required; accepts `{ deliveryIds: string[] }`
- `GET /healthz`: health check endpoint

## Tim Rebase

`tim rebase <planId>` updates a plan's feature branch to be on top of the latest main/trunk branch. It supports both Git and Jujutsu repositories and handles conflict resolution automatically via the executor system.

The command:

1. Resolves the plan's branch (from the `branch` field or calculated from the plan title)
2. Fetches the latest from origin and ensures the local branch is up to date
3. Rebases the branch onto the trunk branch (auto-detected via `getTrunkBranch()`)
4. If conflicts arise, lazily launches an LLM executor in bare mode with VCS-specific conflict resolution prompts
5. Verifies conflicts are resolved after the executor session (errors if not; aborts the rebase for Git)
6. Force-pushes the rebased branch back to origin (`--force-with-lease` for Git, native for Jujutsu)

```bash
tim rebase 123                                # Rebase plan 123's branch
tim rebase --current                          # Rebase the current plan's branch
tim rebase --next                             # Rebase the next ready plan's branch
tim rebase 123 --no-push                      # Rebase without pushing
tim rebase 123 --executor claude-code         # Specify executor for conflict resolution
tim rebase 123 --auto-workspace               # Use auto-workspace (web UI mode)
```

The web interface also provides a **Rebase** button on the plan detail page for plans in `in_progress`, `needs_review`, or `done` states.

## Lifecycle Commands

Tim supports defining lifecycle commands that run automatically when starting and stopping agent sessions (`tim agent` / `tim run`). This is useful for managing dev servers, Docker containers, database migrations, and other setup/teardown tasks.

Configure lifecycle commands in your `tim.yml` config file:

```yaml
lifecycle:
  commands:
    # Managed daemon — spawned as child process, killed on shutdown
    - title: Dev server
      command: node server.js
      mode: daemon

    # External daemon — start something externally, explicit shutdown to clean up
    # check prevents starting (and shutting down) if already running
    - title: Docker containers
      command: docker compose up -d
      check: docker compose ps --status running | grep -q mycontainer
      shutdown: docker compose down

    # Run-and-wait with cleanup on exit
    - title: Seed test data
      command: bun run seed
      shutdown: bun run seed:reset

    # Simple run-and-wait, no cleanup needed
    - title: Run migrations
      command: bun run migrate
```

### Command Options

| Field               | Description                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `title`             | Display name for logging                                                                                                                  |
| `command`           | Shell command to run at startup                                                                                                           |
| `mode`              | `run` (default) — run and wait; `daemon` — spawn as managed child process                                                                 |
| `shutdown`          | Shell command to run at shutdown (for `run` mode) or before killing the daemon (for `daemon` mode)                                        |
| `check`             | Shell command run before startup; if exit 0, both startup and shutdown are skipped (available when `shutdown` is set or mode is `daemon`) |
| `workingDirectory`  | Working directory for the command (defaults to repo root)                                                                                 |
| `env`               | Additional environment variables                                                                                                          |
| `allowFailure`      | If true, startup failure won't abort the agent                                                                                            |
| `onlyWorkspaceType` | Only run in workspaces of this type (`auto`, `standard`, or `primary`); skipped otherwise                                                 |

### Behavior

- **Startup**: Commands run sequentially in config order before the agent execution loop begins.
- **Shutdown**: Commands are processed in reverse order when the agent exits — including on SIGINT/SIGTERM/SIGHUP. Errors during shutdown (including daemon termination failures) are collected and reported after all commands have been attempted.
- **Shutdown timeouts**: Explicit shutdown commands are given 30 seconds by default; if they hang, tim terminates the shutdown process and continues cleaning up remaining lifecycle commands.
- **Daemons**: `mode: daemon` commands are spawned as child processes. On shutdown, they receive SIGTERM (then SIGKILL after 5s timeout) unless an explicit `shutdown` command is provided. If a daemon exits unexpectedly during the agent run (including with exit code 0), a warning is logged.
- **Check**: The `check` command lets you skip startup when the resource is already running, and suppresses the corresponding shutdown so it isn't torn down on exit.
- **Interrupts**: On SIGINT/SIGTERM, the agent stops executing new work immediately and runs lifecycle shutdown before exiting. A second interrupt force-exits.
- **Config merging**: `lifecycle.commands` arrays are concatenated across global, repo, and local configs (global first, then repo, then local).

## Embedded Session Server

Tim long-running commands (`agent`, `generate`, `chat`, `finish`, `rebase`, `review`, `run-prompt`) automatically start an embedded WebSocket server that allows external clients (such as the tim web interface) to connect and monitor the session in real time. Each process advertises itself via a session info file in `~/.cache/tim/sessions/` (respects `XDG_CACHE_HOME`), enabling discovery by the web UI or other tools.

The tim web interface discovers running agent processes by scanning the session directory and connects to their embedded servers as a WebSocket client. Agents do not need to know the GUI's address and no longer open a client connection back to tim-gui.

### Environment Variables

| Variable              | Description                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TIM_SERVER_PORT`     | Port for the embedded server (default: `0` for random). If the port is unavailable, the process exits with an error.                                                            |
| `TIM_NO_SERVER`       | Set to `1` to disable the embedded server entirely. The adapter buffers messages locally with no external visibility.                                                           |
| `TIM_SERVER_HOSTNAME` | Hostname to bind to (default: `127.0.0.1`). Set to `0.0.0.0` for remote/container access.                                                                                       |
| `TIM_WS_BEARER_TOKEN` | When set, requires `Authorization: Bearer <token>` on WebSocket upgrade. The session info file records `token: true` (not the token itself) so consumers know auth is required. |

### Session Info Files

Each running process writes a JSON file at `~/.cache/tim/sessions/<pid>.json` containing the session ID, port, command, workspace path, plan info (including plan UUID), git remote, and whether auth is required. These files are cleaned up automatically on process exit. Stale files from crashed processes are detected by PID liveness checks and cleaned up by the web interface's session discovery client.

## Web Interface

Tim includes a SvelteKit-based web interface for browsing and managing plans. The server-side layer uses lazy initialization to load the tim configuration, sync materialized plan files to the SQLite database, and serve enriched plan data with computed display statuses (e.g. blocked, recently done).

The interface is organized around projects, with tabs per project:

- **Sessions** — real-time monitoring of tim agent processes with live message transcripts, prompt interaction (confirm/input/select/checkbox/prefix_select), and free-form user input. For plan-associated sessions (generate, agent, chat), a split-pane view shows the live plan file content alongside the message stream, updating in real-time as the agent modifies the plan.
- **Active Work** — single-page scrollable dashboard with three sections: **Needs Attention** (plans waiting for input, needing review, or with actionable PRs), **Running Now** (active agent/generate/chat sessions with plan context), and **Ready to Start** (unblocked plans sorted by priority with inline "Run Agent" button). Sections are collapsible with count badges and hidden when empty.
- **Pull Requests** — project-wide view of open GitHub PRs relevant to the user (authored or reviewing), with automatic plan-PR linking based on branch name matching, webhook-first refresh (when configured), and PR detail with checks, reviews, and labels. A "Full Refresh from GitHub API" button provides an escape hatch when webhook data is stale or missing.
- **Plans** — browse, filter, search, and inspect plans with two-column layout (list + detail), status/priority badges, collapsible status groups, and clickable dependency navigation. Review issues on a plan can be managed directly: dismiss individual issues, convert them into plan tasks, or clear all issues at once.
- **Settings** — per-project settings stored in the database (only shown for individual projects, not the "all projects" view). Currently supports a "Featured" toggle that controls sidebar grouping — featured projects appear in the main sidebar list, while non-featured projects are grouped in a collapsible "Other Projects" section at the bottom. Projects default to featured when no setting exists.

Navigation uses route-based project selection at `/projects/{projectId}/{tab}`, with cookie persistence to remember the last-selected project. The home page redirects to the most recently used project. On all tabs, pressing **Option+Down** (Alt+Down) / **Option+Up** (Alt+Up) navigates to the next/previous item in the list, respecting collapsed groups and active filters. Global keyboard shortcuts are also available: **Ctrl+/** focuses the search input, and **Ctrl+1/2/3/4** switches between the Sessions, Active Work, Pull Requests, and Plans tabs.

The web interface supports PWA installation, allowing it to be added to your desktop or mobile home screen and run as a standalone app without browser chrome. Static assets are cached by a service worker for faster loads, while API calls and real-time connections (SSE, WebSocket) always go through the network. When installed as a PWA, the app icon shows a badge dot whenever any session needs attention (active prompt or unhandled notification).

The terminal app used by the "Open Terminal" button is configurable via the `terminalApp` config field (defaults to WezTerm). Set it to `"Terminal"`, `"iTerm"`, or any other macOS terminal application name. macOS only.

```bash
# Start the dev server
bun run dev
```

## Development

```bash
# Install dependencies
bun install

# Type checking
bun run check

# Linting
bun run lint

# Code formatting
bun run format

# Run the full test suite
bun run test

# Install globally for development
bun run dev-install
```

## Building

```bash
bun run build
```

Uses `@sveltejs/adapter-node` for the SvelteKit web interface.
