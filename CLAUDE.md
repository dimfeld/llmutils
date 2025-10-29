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
- `rmplan`: Generates and manages step-by-step project plans using LLMs (organized with separate sub-command modules)
- `apply-llm-edits`: Applies LLM-generated edits back to the codebase
- `rmrun`: Sends rmfilter output to an LLM and applies edits
- `rmfix`: Toolkit for fixing LLM-generated code when it doesn't apply cleanly

## Core Architecture

The codebase is organized into several main modules with improved modularity and clear separation of concerns:

1. **common**: Centralized shared utilities and infrastructure
   - CLI utilities (`cli.ts`), file system operations (`fs.ts`), Git integration (`git.ts`)
   - Process management (`process.ts`), terminal interaction (`terminal.ts`)
   - Clipboard support with OSC52 (`clipboard.ts`, `osc52.ts`)
   - SSH detection (`ssh_detection.ts`) and model factory (`model_factory.ts`)
   - GitHub integration utilities in `github/` subdirectory

2. **rmfilter**: Prepares code context for LLMs with support for different edit formats (diff, whole-file, XML)
   - Uses repomix for context preparation
   - Supports dependency analysis to include related files
   - Handles configuration via YAML files with preset support

3. **rmplan**: Manages step-by-step project plans with LLM integration, organized by sub-commands
   - Modular command structure in `commands/` directory with separate files per sub-command
   - Core functionality: `add.ts`, `agent.ts`, `generate.ts`, `list.ts`, `next.ts`, `done.ts`
   - Specialized commands: `answer-pr.ts`, `cleanup.ts`, `extract.ts`, `split.ts`, `validate.ts`, `set.ts`
   - Workspace management: `workspace.ts` with automated isolation support
   - Shared utilities captured in purpose-built modules:
     - `plan_display.ts`: Resolves plans and assembles context summaries for both CLI output and MCP tooling
     - `plan_merge.ts`: Handles delimiter-aware plan detail updates and task merging while preserving metadata
     - `ready_plans.ts`: Implements readiness detection, filtering, and sorting used by the CLI and MCP list tools
   - MCP server (`mcp/generate_mode.ts`) now focuses on registering prompts and delegates tool handlers to the relevant command modules
   - Executor system in `executors/` for different LLM integration approaches
   - **Automatic Parent-Child Relationship Maintenance**: All commands (`add`, `set`, `validate`) work together to ensure bidirectional consistency in the dependency graph, automatically updating parent plans when child relationships are created, modified, or removed

4. **apply-llm-edits**: Processes LLM-generated edits and applies them to the codebase
   - Supports different edit formats (unified diff, search/replace, XML, whole-file)
   - Handles interactive retry mechanisms for failed edits
   - Offers options for dry-runs and partial application

5. **dependency_graph**: Analyzes file import relationships
   - Resolves import paths and walks import trees
   - Essential for the `--with-imports` and `--with-all-imports` options

6. **editor**: Contains parsing and prompting logic for different edit formats
   - diff-editor: For classic diff-style edits
   - udiff-simple: For unified diff format
   - whole-file: For complete file replacements
   - xml: For XML-formatted edits

7. **state_machine**: Provides an event-driven state machine implementation
   - Manages state transitions with explicit type safety
   - Supports hierarchical state machines with sub-machines
   - Includes OpenTelemetry integration for observability
   - Features rollback capabilities for failed operations

## rmplan Claude Code Workflow

- `rmplan generate --claude` runs a three-step Claude Code session: planning → research capture → plan generation. The middle step prompts Claude to summarize its findings, which are appended under a `## Research` heading in the plan's `details` markdown before the plan is parsed.
- Research notes are preserved on disk inside the plan file. Open the plan and scroll to the `## Research` section in the `details` field to review or edit Claude's findings later.
- If the research capture step fails, the orchestrator falls back to the traditional two-step process so existing workflows keep working.

## rmplan Simple Mode

The `rmplan agent --simple` flag activates a streamlined implement → verify loop. The CLI derives an `executionMode: 'simple'` value and propagates it together with `simpleMode: true` in `ExecutorCommonOptions`, so both Claude Code (`src/rmplan/executors/claude_code.ts`) and Codex CLI (`src/rmplan/executors/codex_cli.ts`) know to switch code paths. Executors can also opt into the same behavior via `executors.<name>.simpleMode` defaults in `rmplan.yaml`.

Claude Code simple mode wraps the orchestrator prompt with `wrapWithOrchestrationSimple()` and replaces the tester/reviewer pair with a single verifier agent generated by `getVerifierAgentPrompt()`. The verifier inherits any custom tester/reviewer instructions and is told to run `bun run check`, `bun run lint`, and `bun test`, adding tests when coverage would otherwise regress. Agent files in `.claude/agents` are pruned to the implementer/verifier pair on each run so stale tester/reviewer definitions cannot leak across executions. Failures surfaced by the verifier map to `sourceAgent: 'verifier'` through `inferFailedAgent()` in `src/rmplan/executors/failure_detection.ts`.

Codex CLI uses `executeSimpleMode()` to reuse the implementer retry logic while stopping after the verifier pass. The verifier context comes from `composeVerifierContext()`, which shares task deltas with the agent prompt used for Claude and makes sure the same verification commands run. Planning-only detection, auto-retry escalation, and completion hooks all work in simple mode because the executor normalizes the telemetry emitted by the implementer and verifier phases.

Because the CLI threads the execution mode through batch, serial, and stub-plan entry points, simple mode respects flags such as `--dry-run`, `--serial-tasks`, and workspace selection without additional conditionals.

## Codex CLI Implementer Auto-Retry

- The Codex executor now captures repository state before and after each implementer attempt using `captureRepositoryState()`, checking both commit hash and working tree status across Git and jj.
- Planning-only outputs are detected when the implementer message contains planning phrases (e.g. lines starting with `Plan:`) and the repository state is unchanged. When detected, the executor retries up to three additional times with progressively stronger instructions to apply the changes immediately.
- Logging surfaces detection and retry activity, for example:
  - `Implementer attempt 1/4 produced planning output without repository changes...`
  - `Retrying implementer with more explicit instructions (attempt 2/4)...`
  - `Implementer produced repository changes after 1 planning-only attempt...`
- Repository state checks gracefully degrade: if either capture fails (common in sandboxed environments), detection is skipped and a warning is emitted instead of forcing retries.
- Real modifications—including direct commits, renames, deletions, and concurrent filesystem edits—prevent false positives by updating either the commit hash or working tree hashes tracked in the comparison.

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

- Don't mock in tests if you can help it.
- Make sure that tests actually test the real code. Don't mock so many things in tests that you aren't testing anything.

## Telemetry & Observability

The codebase uses OpenTelemetry for distributed tracing and monitoring:

- **state_machine**: Implements tracing with spans and events via `telemetry.ts`
- All spans should have descriptive names and relevant attributes
- When working with existing spans, use `getActiveSpan()` rather than creating new ones
- Record events on spans using methods like `recordStateTransition` and `recordError`
- Always handle cases where spans might be undefined with null checks
- When importing OpenTelemetry types, use type-only imports:

```typescript
import type { Tracer, Context, Span, AttributeValue } from '@opentelemetry/api';
```

## Type Safety

TypeScript is used throughout the codebase with strict type checking:

- Always use proper type annotations for function parameters and return types
- Use type guards and runtime validation where appropriate
- When working with external APIs, ensure proper type safety with validation
- Run `bun run check` before committing to ensure no type errors are present

You can check if compilation works using `bun run check`

## Writing Code

See @.cursor/rules/general.mdc for coding guidelines and patterns
See .cursor/rules/plan_files.mdc for tips on working with plan files in rmplan commands

## Code Quality Best Practices

- Use @inquirer/prompts for asking questions to the user

### Testing Strategies

See @.cursor/rules/testing.mdc for testing strategy

### Refactoring Approach

- **Work bottom-up**: Update utility functions first, then callers to minimize compilation errors
- **Use todo lists**: Break complex changes into trackable items for systematic progress
- **Run type checks frequently**: Catch signature mismatches early in the refactoring process
- **Make incremental commits**: Each commit should focus on a single logical change

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
