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
   - Specialized commands: `answer-pr.ts`, `cleanup.ts`, `extract.ts`, `prepare.ts`, `split.ts`, `validate.ts`, `set.ts`
   - Workspace management: `workspace.ts` with automated isolation support
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

## Environment Requirements

- **Bun**: Required as the JavaScript runtime
- **ripgrep**: Used for efficient code searching
- **repomix**: Core tool for context preparation
- **fzf**: Used by rmfind for interactive file selection
- **bat**: Used by rmfind and rmrun for syntax highlighting

## Common Workflow Patterns

1. **Finding and preparing context**:

   ```bash
   # Find relevant files
   rmfind src/**/*.ts --grep "auth"

   # Prepare context with those files
   rmfilter src/auth/**/*.ts --instructions "Implement OAuth flow"
   ```

2. **Creating and executing plans**:

   ```bash
   # Generate a plan
   rmplan generate --plan tasks/new-feature.md -- src/**/*.ts

   # Extract the plan from clipboard to YAML
   rmplan extract --output tasks/new-feature.yml

   # Get next step with context
   rmplan next tasks/new-feature.yml --rmfilter -- src/**/*.ts

   # Mark steps as done and commit
   rmplan done tasks/new-feature.yml --commit
   ```

3. **Applying edits**:

   ```bash
   # Apply edits from clipboard
   apply-llm-edits

   # Apply edits with dry-run
   apply-llm-edits --dry-run
   ```

## Execution Summaries

rmplan run and rmplan agent display a consolidated execution summary at the end of a run. The summary aggregates key outputs from the executor(s), step status, file changes, and timing info.

- What’s captured
- Final LLM messages for each step
  - Claude Code: the orchestrator’s final assistant message
  - Codex CLI: final Implementer/Tester/Reviewer sections combined
- Step status and duration per step
- Aggregate stats (completed/failed steps, total duration)
- Files changed during execution (from the repo root)

- CLI options
- `--no-summary` disables summary collection and display
- `--summary-file <path>` writes the summary to a file instead of stdout (parent dirs created automatically)

- Environment
- `RMPLAN_SUMMARY_ENABLED` enables/disables summaries by default. Set to `0` or `false` to disable; CLI flags still take precedence.

- Usage examples
  - Print to stdout (default): `rmplan agent tasks/123-plan.yml`
  - Disable summaries: `rmplan agent --no-summary tasks/123-plan.yml`
  - Write to file: `rmplan agent --summary-file tmp/summary.txt tasks/123-plan.yml`
  - Batch mode with file output: `rmplan agent --batch-tasks --summary-file runs/summary.txt tasks/parent.yml`

- Executor-specific capture
  - Claude Code: captures the orchestrator’s final assistant message when available
  - Codex CLI: concatenates the final Implementer, Tester, and Reviewer sections
  - Other executors: contribute raw text if provided; otherwise steps still appear without output

- Truncation and performance
  - The collector truncates very large outputs to keep memory use reasonable and adds a truncation notice
  - The display renderer may clamp again for terminal readability
  - Batch runs aggregate iteration counts and failed steps without storing intermediate logs

- Example output (abbreviated)

```

Execution Summary: My Plan Title (3/3 • 100%)
┌───────────────┬──────────────────────────────────────┐
│ Plan ID │ 123 │
│ Mode │ serial │
│ Steps Executed│ 3 │
│ Failed Steps │ 0 │
│ Files Changed │ 5 │
│ Duration │ 1m 12s │
│ Started │ 2025-09-14 02:10:03 │
│ Ended │ 2025-09-14 02:11:15 │
└───────────────┴──────────────────────────────────────┘

Step Results
───────────────────────────────────────────
✔ Task 1 (codex-cli) [#1] 12s
Implementer:
… final implementation notes …
Reviewer:
ACCEPTABLE

File Changes
───────────────────────────────────────────
• tasks/123-some-plan.yml
• src/feature/new.ts

```

- Notes
- Summaries are truncated to keep memory usage reasonable (collector truncates large outputs; display may clamp further).
- Batch mode aggregates results across iterations; the metadata includes iteration counts and failed steps.
- Executors without structured output still contribute raw text.
- If output capture fails, the summary records the error without failing the run.

## Configuration Files

The repository uses several configuration files:

- `.rmfilter/`: Directory for rmfilter preset configurations
- `schema/`: Contains JSON schemas for validating configurations
- Environment variables (via dotenv) for model configuration

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
