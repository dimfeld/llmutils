# llmutils

Command-line utilities for managing context with chat-oriented programming and applying edits from language models.

## Key Commands

- **rmfilter**: Analyzes import trees to gather related files, adds instructions, and prepares context for LLMs
- **rmfind**: Finds relevant files to use with rmfilter
- **tim**: Generates and manages step-by-step project plans using LLMs
- **apply-llm-edits**: Applies LLM-generated edits back to the codebase
- **rmrun**: Sends rmfilter output to an LLM and applies edits
- **rmfix**: Toolkit for fixing LLM-generated code when it doesn't apply cleanly

## Web Interface

Tim includes a SvelteKit-based web interface for browsing and managing plans. The server-side layer uses lazy initialization to load the tim configuration, sync plan files to the SQLite database, and serve enriched plan data with computed display statuses (e.g. blocked, recently done).

The interface is organized around projects, with three tabs per project:

- **Sessions** — real-time monitoring of tim agent processes with live message transcripts, prompt interaction (confirm/input/select/checkbox), free-form user input, and a terminal button for WezTerm-backed sessions that focuses the associated pane through a server-side remote command. Connects to agents via WebSocket server on port 8123 and streams updates to the browser via SSE.
- **Active Work** — dashboard of current work per project showing workspaces (with Primary/Locked/Available status badges) and active plans (in_progress + blocked). Workspaces are filtered to "recently active" by default (locked, primary, or updated within 48 hours) with a toggle to show all. Clicking a plan shows full detail in the right pane.
- **Plans** — browse, filter, search, and inspect plans with two-column layout (list + detail), status/priority badges, collapsible status groups, and clickable dependency navigation

Navigation uses route-based project selection at `/projects/{projectId}/{tab}`, with cookie persistence to remember the last-selected project. The home page redirects to the most recently used project.

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

# Run tests
bun test

# Run web interface tests
bun run test:web

# Install globally for development
bun run dev-install
```

## Building

```bash
bun run build
```

Uses `@sveltejs/adapter-node` for the SvelteKit web interface.
