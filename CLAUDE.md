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

This repository contains command-line utilities for managing context with chat-oriented programming and applying edits from language models. The key commands are:

- `rmfilter`: Analyzes import trees to gather related files, adds instructions, and prepares context for LLMs
- `rmfind`: Finds relevant files to use with rmfilter
- `rmplan`: Generates and manages step-by-step project plans using LLMs
- `apply-llm-edits`: Applies LLM-generated edits back to the codebase
- `rmrun`: Sends rmfilter output to an LLM and applies edits
- `rmfix`: Toolkit for fixing LLM-generated code when it doesn't apply cleanly

## Core Architecture

The codebase is organized into several main modules:

1. **rmfilter**: Prepares code context for LLMs with support for different edit formats (diff, whole-file, XML)

   - Uses repomix for context preparation
   - Supports dependency analysis to include related files
   - Handles configuration via YAML files with preset support

2. **rmplan**: Manages step-by-step project plans with LLM integration

   - Generates planning prompts
   - Extracts Markdown plans into YAML format
   - Tracks progress and executes steps with potential Git integration

3. **apply-llm-edits**: Processes LLM-generated edits and applies them to the codebase

   - Supports different edit formats (unified diff, search/replace, XML, whole-file)
   - Handles interactive retry mechanisms for failed edits
   - Offers options for dry-runs and partial application

4. **dependency_graph**: Analyzes file import relationships

   - Resolves import paths and walks import trees
   - Essential for the `--with-imports` and `--with-all-imports` options

5. **editor**: Contains parsing and prompting logic for different edit formats

   - diff-editor: For classic diff-style edits
   - udiff-simple: For unified diff format
   - whole-file: For complete file replacements
   - xml: For XML-formatted edits

6. **state_machine**: Provides an event-driven state machine implementation

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