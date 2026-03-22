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

Use `tim workspace list`, `tim workspace add`, and `tim workspace update` to manage repository workspaces. Workspaces can be `standard`, `primary`, or `auto`: `primary` workspaces are reserved for branch/push operations, while `auto` workspaces form the preferred pool for `--auto-workspace`.

`tim workspace add [planIdentifier] [--primary | --auto]` sets the initial type for a new workspace, and `tim workspace update <id> [--primary | --no-primary | --auto | --no-auto]` changes it later. When at least one `auto` workspace exists, commands such as `tim agent --auto-workspace` and `tim generate --auto-workspace` only choose from `auto` workspaces; otherwise they fall back to any non-`primary` workspace. See [`docs/multi-workspace-workflow.md`](docs/multi-workspace-workflow.md) for the full workflow.

## PR Status Monitoring

`tim pr` is a subcommand namespace for GitHub PR operations:

- `tim pr status [planId]` — Fetch and display PR status for a plan (checks, reviews, merge readiness) with color-coded terminal output. Resolves the plan from a positional argument or the current workspace plan (walks parent directories to find the workspace root).
- `tim pr link <planId> <prUrl>` — Link a PR to a plan. Validates the PR exists on GitHub, rejects non-PR URLs (e.g. issue URLs), and canonicalizes the URL before updating the plan file.
- `tim pr unlink <planId> <prUrl>` — Remove a PR link from a plan.
- `tim pr description <planFile>` — Generate a PR description from a plan (migrated from the former `tim pr-description` command, which remains as a hidden alias for backwards compatibility).

PR status data (check runs, reviews, labels, merge state) is cached in the SQLite database and surfaced in the web interface. The CLI always force-refreshes from GitHub; the web UI uses stale-while-revalidate caching. Requires `GITHUB_TOKEN` environment variable for GitHub API access.

## Web Interface

Tim includes a SvelteKit-based web interface for browsing and managing plans. The server-side layer uses lazy initialization to load the tim configuration, sync plan files to the SQLite database, and serve enriched plan data with computed display statuses (e.g. blocked, recently done).

The interface is organized around projects, with three tabs per project:

- **Sessions** — real-time monitoring of tim agent processes with live message transcripts, prompt interaction (confirm/input/select/checkbox/prefix_select), free-form user input, end session with confirmation for active sessions, and a terminal button for WezTerm-backed sessions that focuses the associated pane through a server-side remote command. Connects to agents via WebSocket server on port 8123 and streams updates to the browser via SSE. Plans can be acted on directly from the plan detail view: stub plans (no tasks) can be generated via `tim generate`, and plans with tasks can be executed via `tim agent` — both spawn detached processes that appear as new sessions.
- **Active Work** — dashboard of current work per project showing workspaces (with Primary/Auto/Locked/Available status badges) and active plans (in_progress + blocked). Workspaces are filtered to "recently active" by default (locked, primary, or updated within 48 hours) with a toggle to show all. Clicking a plan shows full detail in the right pane.
- **Plans** — browse, filter, search, and inspect plans with two-column layout (list + detail), status/priority badges, collapsible status groups, and clickable dependency navigation

Navigation uses route-based project selection at `/projects/{projectId}/{tab}`, with cookie persistence to remember the last-selected project. The home page redirects to the most recently used project.

The web interface supports PWA installation, allowing it to be added to your desktop or mobile home screen and run as a standalone app without browser chrome. Static assets are cached by a service worker for faster loads, while API calls and real-time connections (SSE, WebSocket) always go through the network. When installed as a PWA, the app icon shows a badge dot whenever any session needs attention (active prompt or unhandled notification).

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

# Run CLI tests only
bun run test-cli

# Run web interface tests only
bun run test-web

# Install globally for development
bun run dev-install
```

## Building

```bash
bun run build
```

Uses `@sveltejs/adapter-node` for the SvelteKit web interface.
