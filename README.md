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

- **Sessions** — (coming soon)
- **Active Work** — (coming soon)
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
