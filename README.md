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

## Workspace Management

Use `tim workspace list`, `tim workspace add`, and `tim workspace update` to manage repository workspaces. Workspaces can be `standard`, `primary`, or `auto`: `primary` workspaces are reserved for branch/push operations, while `auto` workspaces form the preferred pool for `--auto-workspace`.

`tim workspace add [planIdentifier] [--primary | --auto]` sets the initial type for a new workspace, and `tim workspace update <id> [--primary | --no-primary | --auto | --no-auto]` changes it later. When at least one `auto` workspace exists, commands such as `tim agent --auto-workspace` and `tim generate --auto-workspace` only choose from `auto` workspaces; otherwise they fall back to any non-`primary` workspace. See [`docs/multi-workspace-workflow.md`](docs/multi-workspace-workflow.md) for the full workflow.

## Web Interface

Tim includes a SvelteKit-based web interface for browsing and managing plans. The server-side layer uses lazy initialization to load the tim configuration, sync plan files to the SQLite database, and serve enriched plan data with computed display statuses (e.g. blocked, recently done).

The interface is organized around projects, with three tabs per project:

- **Sessions** — real-time monitoring of tim agent processes with live message transcripts, prompt interaction (confirm/input/select/checkbox/prefix_select), free-form user input, and a terminal button for WezTerm-backed sessions that focuses the associated pane through a server-side remote command. Connects to agents via WebSocket server on port 8123 and streams updates to the browser via SSE. Stub plans can also be generated directly from the plan detail view — the spawned `tim generate` process appears as a new session.
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
