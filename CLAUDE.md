# Repository Guide

Guidance for agents working in this repository.

## Build Commands

```bash
bun install          # Install dependencies
bun run check        # Type check (server)
bun run check-web    # Type check (web)
bun run lint         # Lint
bun run format       # Format
bun run test         # Run server/node tests
bun run test:client  # Run browser-mode Svelte tests
```

Use `bun run test` for the server/Node test project. Do not use `bun test` or `bunx vitest run` — they run the wrong test runner.

## Repository Overview

Top-level source layout:

- `src/common/` — shared utilities (CLI, fs, git, process, cleanup registry, terminal, config paths, GitHub integration, webhook ingest, prompts)
- `src/tim/` — plan management commands, DB layer, workspace management, MCP server, executors
- `src/lib/`, `src/routes/` — SvelteKit web interface (plans browser, sessions monitor)
- `src/rmfilter/`, `src/rmfind/`, `src/apply-llm-edits/`, etc. — other legacy CLI entry points

## Documentation Index

Read the relevant doc before working in these areas:

- **Testing** → `docs/testing.md`
- **Refactoring** → `docs/refactoring.md`
- **Web interface** (SvelteKit conventions, gotchas) → `docs/web-interface.md`
- **Database** → `docs/database.md`
- **Sync operations** (REQUIRED before changing synced plan/project mutations) → `docs/sync-operations-guide.md`
- **Multi-workspace workflow** → `docs/multi-workspace-workflow.md`
- **Parent-child plan relationships** → `docs/parent-child-relationships.md`
- **Planning workflow** → `docs/planning.md`
- **Batch tasks** → `docs/batch-tasks-feature.md`
- **Next-ready plan logic** → `docs/next-ready-feature.md`
- **Linear integration** → `docs/linear-integration.md`
- **Slack integration** → `docs/slack-integration.md`
- **GitHub diffs** → `docs/github-diffs.md`
- **Git/jj patterns** → `docs/git-jj-patterns.md`
- **OS process interaction** → `docs/os-process-interaction.md`
- **Executor stdin conventions** → `docs/executor-stdin-conventions.md`
- **Codex CLI integration** (execution modes, shared orchestration prompt) → `docs/codex-cli-integration.md`
- **Implementer / reviewer instructions** → `docs/implementer-instructions.md`, `docs/reviewer-instructions.md`
- **Sync between nodes** → `docs/sync-between-nodes.md`
- **Import command** → `docs/import_command.md`
- **Safe path handling** (containment checks, symlink safety, denylists) → `docs/path-safety.md`

## Always-On Rules

### Type safety

- Always annotate function parameters and return types.
- Run `bun run check` before considering work complete; no type errors.

### Configuration

When adding new values to `configSchema.ts`, do not put defaults in the zod schemas — it breaks merging of local and main configs. Apply defaults where values are read, or set them in `loadEffectiveConfig` after merging.

This "no defaults" rule does **not** forbid _validation_ in the schema. Format-correctness checks (`.refine()`, `.regex()`, enum/range constraints — e.g. an `HH:MM` time or an IANA timezone) belong in the zod schema so misconfiguration is rejected at config-load time. Prefer schema validation over a standalone validator helper: a validator that nothing calls on the read path gives no real protection.

### Testing

- Don't mock if you can help it. Tests must exercise real code.
- Cover happy path, edge cases, and error handling.
- When modifying task management commands or MCP tools, reuse the cross-interface scenarios in `src/tim/commands/task-management.integration.test.ts`.
- Enable test console logging with `TEST_ALLOW_CONSOLE=true`. Do **not** set `TEST_ALLOW_CONSOLE=false` — the default is off and the var's presence confuses the Bash tool.

### Prompts

Use prompts from `src/common/input.ts` for user questions — these wrap `@inquirer/prompts` and route correctly through tunnel/headless modes. Use `promptPrefixSelect()` for Bash command prefix selection.

### Workflow

- After changing files, look for related tests to update or add.
- After finishing a change, run `bun run test` and fix any failures.
- After adding a feature, update the README.
- Format code with `bun run format` after making changes.

## Quick Tips

- Don't use `await import('module')` for regular imports — use a top-level import.
- TypeScript exhaustive switches (`never` in default) only check at compile time. At runtime, unknown values silently return `undefined`. Add a real `default` if runtime safety matters.
- Validation that can throw must run **before** any resource allocation in the same function — otherwise the throw leaks resources because the surrounding `finally` hasn't been entered.
