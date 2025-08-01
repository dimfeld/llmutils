# llmutils

Command-line utilities for managing context with chat-oriented programming, and applying edits back. The codebase is designed with a modular architecture for enhanced maintainability and clear separation of concerns.

The scripts are:

- `rmfilter` - A wrapper around repomix which can analyze import trees to gather all the files referenced by a root file, and add instructions and other rules to the repomix output. Supports both "whole file" and "diff" edit modes.
- `apply-llm-edits` - Once you've pasted the rmfilter output into a chat model and get the output, you can use this script to apply the edits back to your codebase.
- `rmrun` - Send the rmfilter output to a language model and apply the edits back.
- `rmfind` - Find relevant files to use with rmfilter
- `rmplan` - Generate and manage step-by-step project plans for code changes using LLMs, with support for creating, importing from GitHub issues, validating, splitting, and executing tasks. Includes multi-phase planning for breaking large features into incremental deliverables and automated dependency-based execution for complex project workflows.
- `rmpr` - Handle pull request comments and reviews with AI assistance

All tools include built-in OSC52 clipboard support to help with clipboard use during SSH sessions.

Some of the features, such as dependency analysis, only work with the code I've been writing at work recently, and so
assume a repository written with Typescript and PNPM workspaces.

# Table of Contents

- [Installation](#installation)
  - [Build Instructions](#build-instructions)
- [Key Features](#key-features)
  - [SSH Support with OSC52](#ssh-support-with-osc52)
- [Configuration and Presets](#configuration-and-presets)
  - [YAML Configuration](#yaml-configuration)
  - [Example Config File](#example-config-file)
  - [Using Config Files](#using-config-files)
  - [Preset System](#preset-system)
  - [Combining CLI and Config](#combining-cli-and-config)
  - [MDC File Support](#mdc-file-support)
    - [Key Features of MDC Support](#key-features-of-mdc-support)
    - [MDC File Format](#mdc-file-format)
  - [Model Presets](#model-presets)
- [rmfind](#rmfind)
  - [Key Features](#key-features-2)
  - [Usage](#usage)
  - [Requirements](#requirements)
  - [Notes](#notes)
- [rmplan](#rmplan)
  - [Key Features](#key-features-3)
  - [Usage](#usage-1)
    - [Cleanup Command](#cleanup-command)
  - [Requirements](#requirements-1)
  - [Notes](#notes-1)
  - [Configuration](#configuration)
    - [Paths](#paths)
    - [Documentation Search Paths](#documentation-search-paths)
    - [Workspace Auto-Creation](#workspace-auto-creation)
    - [Automatic Examples](#automatic-examples)
    - [Post-Apply Commands](#post-apply-commands)
  - [Executors](#executors)
    - [Available Executors](#available-executors)
  - [Multi-Phase Project Planning](#multi-phase-project-planning)
- [rmpr](#rmpr)
  - [Key Features](#key-features-4)
  - [Usage](#usage-2)
  - [Options Editor](#options-editor)
- [Usage Examples](#usage-examples)
  - [Using rmfilter](#using-rmfilter)
  - [Using rmplan](#using-rmplan)
  - [Using rmpr](#using-rmpr)
  - [Applying LLM Edits](#applying-llm-edits)

## Installation

This project assumes you have these tools installed:

- [Bun](https://bun.sh/)
- [ripgrep](https://github.com/BurntSushi/ripgrep)
- [repomix](https://github.com/yamadashy/repomix)
- [fzf](https://github.com/junegunn/fzf) (for rmfind)
- [bat](https://github.com/sharkdp/bat) (for rmfind and rmrun)
- [claude Code](https://github.com/anthropics/claude-code) (optional, for Claude Code support)

### Build Instructions

Clone the repository, install dependencies, and then install globally:

```bash
git clone https://github.com/dimfeld/llmutils.git
cd llmutils
bun install
pnpm add -g file://$(pwd)
```

## Key Features

### SSH Support with OSC52

llmutils now includes built-in OSC52 clipboard support for improved functionality when working over SSH sessions:

- **Automatic SSH Detection**: Automatically detects when you're running in an SSH session by checking environment variables like `SSH_CLIENT` and `SSH_CONNECTION`.

- **Clipboard Integration**:
  - **Copy Operations**: When running in an SSH session, automatically uses OSC52 escape sequences to copy content to your local machine's clipboard.
  - **Read Operations**: First attempts to read from the local clipboard using OSC52, with an automatic fallback to standard mechanisms if OSC52 fails or times out.

- **Terminal Requirements**: For full OSC52 functionality, your terminal emulator must support OSC52 escape sequences. Modern terminal emulators generally have good support, but may need extra configuration to enable all features.

#### Manual Pasting

Reading from the clipboard over an SSH session doesn't work well inside of many terminal emulators or workspace managers. To accommodate that, at any time when you would normally press enter to have the tools read the clipboard, you can instead just manually paste your clipboard contents in and it will read it.

## Configuration and Presets

`rmfilter` supports configuration through YAML files, allowing you to define reusable settings and commands. You can specify a config file directly with `--config` or use presets with `--preset`, which are stored in `.rmfilter/` directories or `$HOME/.config/rmfilter/`.

### YAML Configuration

The YAML config file allows you to set global options and define multiple commands. Here's the structure:

- **Global options**: Options like `edit-format`, `output`, `copy`, `instructions`, etc., that apply to all commands.
- **Commands**: An array of command-specific settings, each containing `globs` and command options like `grep`, `with-imports`, etc.

The configuration is validated against a schema (available at `https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmfilter-config-schema.json`). You can reference it in your YAML file with:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmfilter-config-schema.json
```

### Example Config File

Here's an example YAML configuration:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmfilter-config-schema.json
edit-format: diff
copy: true
instructions: |
  Update all API calls to use the new endpoint format
docs:
  - 'docs/**/*.md'
rules:
  - '.cursorrules'
commands:
  - globs:
      - 'src/api/**/*.ts'
    grep:
      - 'fetch'
    with-imports: true
    with-tests: true
    example-file: 'fetch=src/api/fetchData.ts'
  - globs:
      - 'src/tests/api/**/*.ts'
    grep: 'test'
    example: 'apiTest'
```

This config:

- Sets the edit format to `diff` and copies output to the clipboard.
- Includes instructions for updating API calls and references a file for additional instructions.
- Includes all markdown files in `docs/` and `.cursorrules` for context.
- Defines two commands: one for API source files with `fetch`, including their imports, test files, and a specific example file, and another for test files with an example pattern.

### Using Config Files

To use a config file directly:

```bash
rmfilter --config path/to/config.yml
```

### Preset System

Presets are named YAML files stored in:

- `.rmfilter/` directories, searched from the current directory up to the git root.
- `$HOME/.config/rmfilter/` for user-wide presets.

To use a preset:

```bash
rmfilter --preset example
```

This loads `.rmfilter/example.yml` (or from `$HOME/.config/rmfilter/example.yml` if not found locally).

### Combining CLI and Config

CLI arguments override YAML settings. For example:

```bash
rmfilter --preset example --edit-format diff src/extra/**/*.ts
```

This uses the `example` preset but changes the edit format to `diff` and adds an extra glob.

### MDC File Support

`rmfilter` supports `.mdc` (Markdown Domain Configuration) files, which are used to define project-specific rules and documentation, particularly for AI-powered code editors like Cursor. These files are automatically detected and processed to provide additional context for your tasks.

#### Key Features of MDC Support

- **Automatic Detection**: `rmfilter` searches for `.mdc` files in the `.cursor/rules/` directory of your project and in `~/.config/rmfilter/rules/`. It includes these files based on their relevance to the active source files.
- **Glob-based Filtering**: MDC files can specify `globs` in their frontmatter (e.g., `*.tsx`, `app/controllers/**/*.rb`) to indicate which source files they apply to. Only MDC files matching the active source files are included.
- **Grep-based Filtering**: MDC files can include a `grep` field (e.g., `grep: superform, supervalidate`) to match against specific terms (case-insensitive). The grep terms are searched in both the instructions passed to `rmfilter` and the source file contents. This ensures only relevant MDC files are included based on the current task context.
- **Type Classification**: MDC files can have a `type` field (e.g., `docs` or `rules`) to categorize them as documentation or coding rules. These are organized into `<documents>` or `<rules>` tags in the output, respectively. The default value is `rules`.
- **Suppression Option**: Use the `--no-autodocs` CLI flag to disable automatic MDC file processing if needed.

MDC files with both `globs` and `grep` must match both to be included. Note that the `grep` field is unique to this tool, not part of Cursor's implementation. An MDC file with neither `globs` nor `grep` will always be included, unless the `no-autodocs` option is passed.

#### MDC File Format

An `.mdc` file is a Markdown-based file with a YAML frontmatter header. Here's an example:

```markdown
---
description: Rules for Svelte components with Superforms
globs: '*.svelte, *.ts' # Or a YAML array
type: docs
grep: superform, supervalidate # Or a YAML array
name: svelte-superform
---

Docs for Superforms would go here
```

- **Frontmatter Fields**: Includes `description` (purpose of the rule), `globs` (file patterns), `grep` (search terms), `type` (docs or rules), and optional fields like `name` or `metadata`.
- **Body**: Contains the rules or documentation in Markdown, often with coding standards or AI instructions.

### Model Presets

The `--model` option can be passed to `rmfilter` to configure settings for particular AI models. The supported options are:

- `--model grok`: Sets the edit format to `diff` and adds an instruction to the prompt about not creating artifacts.
- `--model gemini`: Adds an "overeager" guideline to the prompt (copied from Aider) about closely keeping to the scope of the task.

## rmfind

The `rmfind` utility helps you locate relevant files in your repository using a combination of glob patterns, ripgrep patterns, and natural language queries. It integrates with `fzf` for interactive file selection, allowing you to refine your file list efficiently. The output can be copied to the clipboard and formatted as a space-separated list or YAML array.

### Key Features {#key-features-2}

- **Glob-based file search**: Find files matching specific patterns (e.g., `src/**/*.ts`).
- **Ripgrep integration**: Filter files by content using ripgrep patterns, with options for whole-word matching and case expansion (e.g., snake_case to camelCase).
- **Natural language queries**: Use AI to filter files based on a query (e.g., "find files related to user authentication").
- **Interactive selection**: Pipe results to `fzf` for interactive file selection with a preview window (requires `fzf` and `bat` for syntax highlighting).
- **Flexible output**: Output file paths as a space-separated list or YAML array, with automatic clipboard copying.

### Usage

Run `rmfind` with various options to find and select files:

```bash
# Find Typescript files in src/ and select interactively with fzf
rmfind src/**/*.ts

# Filter files containing "fetch" or "api" and select with fzf
rmfind src/**/*.ts --grep fetch --grep api

# Use a natural language query to find relevant files
rmfind src/**/*.ts --query "files handling user authentication"

# Search from the git root and output as YAML
rmfind --gitroot src/**/*.ts --yaml

# Combine globbing and grep with whole-word matching
rmfind src/**/*.ts --grep user --whole-word

# Use a specific AI model for querying
rmfind src/**/*.ts --query "database migrations" --model google/gemini-2.5-flash-preview-05-20
```

### Requirements

- `fzf`: For interactive file selection.
- `bat`: For syntax-highlighted previews in `fzf` (optional, falls back to `cat` if unavailable).
- `ripgrep`: For content-based filtering.
- AI SDK: Required for natural language queries (configured with the `--model` option).

### Notes

- The `--query` option requires an AI model and may incur usage costs depending on the model provider.
- Use `--debug` to see detailed logs for troubleshooting.
- The `--quiet` flag suppresses non-error output for cleaner scripting.

## rmplan

The `rmplan` utility generates and manages step-by-step project plans for code changes using LLMs. It supports creating, validating, and executing tasks, ensuring incremental progress with detailed prompts for code generation.

You can find the task plans for this repository under the "tasks" directory.

### Key Features {#key-features-3}

- **Plan Generation**: Create detailed project plans from a text description, breaking down tasks into small, testable steps.
- **Plan Creation**: Use the `add` command to quickly create new plan stub files with metadata like dependencies and priority.
- **Issue Import**: Use the `import` command to convert GitHub issues into structured plan files, with support for both single-issue and interactive multi-issue import modes, automatic duplicate prevention, and selective content inclusion.
- **Plan Splitting**: Use the `split` command to intelligently break down large, complex plans into multiple phase-based plans using an LLM.
- **Research Integration**: Use the `research` command to generate research prompts based on a plan's goals and append findings back to the plan for enhanced context.
- **YAML Conversion**: Convert the Markdown project plan into a structured YAML format for running tasks.
- **Task Execution**: Execute the next steps in a plan, generating prompts for LLMs and optionally integrating with `rmfilter` for context.
- **Progress Tracking**: Mark tasks and steps as done, with support for committing changes to git or jj.
- **Plan Inspection**: Display detailed information about plans including dependencies with resolution, tasks with completion status, and metadata.
- **Smart Plan Selection**: Find the next ready plan (status pending with all dependencies complete) using `--next` flag on `show`, `agent`, `run`, and `prepare` commands.
- **Dependency-Based Execution**: Use `--next-ready <parentPlan>` to automatically find and execute the next actionable dependency in complex multi-phase projects, with intelligent prioritization and comprehensive error feedback.
- **Flexible Input**: Accept plans from files, editor input, or clipboard, and output results to files or stdout.
- **Workspace Auto-Creation**: Automatically create isolated workspaces (Git clones or worktrees) for each task, ensuring clean execution environments.
- **Manual Workspace Management**: Use the `workspace add` command to explicitly create workspaces with or without plan associations, and `workspace list` to view all workspaces and their lock status.

### Usage

The general usage pattern is that you will:

1. Use the `generate` command to generate a planning prompt. Pass `rmfilter` arguments after a `--` to add the appropriate files to
   inform the generation.
2. Paste the output of that into a language model. As of April 2025, Google Gemini 2.5 Pro is probably the best choice.
3. Copy its output to the clipboard.
4. Press enter to continue, which will extract the Markdown plan and write it as YAML. (You can also run the `extract` command directly to do this.)
5. Use the `next` command to get the prompt for the next step(s).
6. Run the prompt with whatever LLM or coding agent you prefer.
7. Use the `done` command to mark the next step(s) as done and commit changes.

Then repeat steps 5 through 7 until the task is done.

Alternatively, you can use the `agent` command (or its alias `run`) to automate steps 5 through 7, executing the plan step-by-step with LLM integration and automatic progress tracking.

### Using with Claude Code

The `generate` and `prepare` commands support a `--claude` flag that leverages Anthropic's Claude Code model for enhanced planning and generation capabilities. This feature uses a two-step invocation process:

1. **Planning Phase**: Claude Code first analyzes the task and creates a structured plan
2. **Generation Phase**: Using the same session context, Claude Code generates the final output in the required format

This two-step approach produces more thoughtful and accurate results compared to single-pass generation, as Claude Code can reason about the task structure before generating detailed implementation steps.

**Requirements**: The `claude-code` CLI tool must be installed and available in your system's PATH.

**Examples**:

```bash
# Generate a plan using Claude Code instead of the default model
rmplan generate --plan tasks/feature.md --claude -- src/**/*.ts

# Generate from a GitHub issue using Claude Code
rmplan generate --issue 42 --claude -- src/api/**/*.ts

# Prepare detailed steps for a phase using Claude Code
rmplan prepare tasks/phase-1.yml --claude

# You can combine with other options as usual
rmplan generate --plan-editor --claude --commit -- src/**/*.ts
```

The `--claude` flag works seamlessly with all other options for both commands. When not specified, the commands use their default behavior of calling the configured LLM directly.

### Additional Commands

The `prepare` command is used to generate detailed steps and prompts for a phase plan that doesn't already have them. This is useful when you have a high-level plan outline but need to expand it with specific implementation steps.

The `add` command allows you to quickly create new plan stub files with just a title. These stubs can then be populated with detailed tasks using the `generate` command. This is particularly useful when you want to quickly capture ideas for future work or create a set of related plans with proper dependencies.

The `split` command helps manage complexity by using an LLM to intelligently break down a large, detailed plan into multiple smaller, phase-based plans. Each phase becomes a separate plan file with proper dependencies, allowing you to tackle complex projects incrementally while maintaining the full context and details from the original plan.

The `research` command generates a research prompt based on a plan's goal and details, helping you gather additional context or information to enhance the plan. The `--rmfilter` option incorporates file context into the research prompt using `rmfilter`, allowing you to include relevant code files and documentation. After running the research prompt through an LLM, the command provides an interactive paste-back mechanism where you can paste the research findings, and they will be automatically appended to the plan file's `research` field for future reference.

The `update` command allows you to modify an existing plan by providing a natural language description of the desired changes. This enables iterative refinement of plans as requirements evolve or new information becomes available. The command uses an LLM to intelligently update the plan's tasks and structure while preserving important metadata.

When running `rmplan next` to paste the prompt into a web chat or send to an API, you should include the --rmfilter option to include the relevant files and documentation in the prompt. Omit this option when using the prompt with Cursor, Claude Code, or other agentic editors because they will read the files themselves.

**Note**: When working with plan files, you can use either the file path (e.g., `plan.yml`) or the plan ID (e.g., `123`) for commands like `done`, `next`, `agent`, `run`, and `prepare`. The plan ID is found in the `id` field of the YAML file and rmplan will automatically search for matching plans in the configured tasks directory.

Run `rmplan` with different commands to manage project plans:

```bash
# Generate a plan from a text file and pass extra args to rmfilter
rmplan generate --plan plan.txt -- src/**/*.ts --grep auth

# Open an editor to write a plan and generate a prompt, and include apps/web as context
rmplan generate --plan-editor -- apps/web

# Generate a plan from a GitHub issue. This assumes you have a GitHub token set in the GITHUB_TOKEN environment variable
rmplan generate --issue https://github.com/dimfeld/llmutils/issues/28

# Generate a plan from the GitHub issue for this repository with this number
rmplan generate --issue 28

# Generate a plan and commit the resulting YAML file
rmplan generate --plan plan.txt --commit -- src/**/*.ts

# Import GitHub issues as stub plan files
# Import a specific issue by number or URL
rmplan import --issue 123
rmplan import --issue https://github.com/owner/repo/issues/456

# Interactive mode to select and import multiple issues
rmplan import

# Import with custom output location
rmplan import --issue 123 --output custom-tasks/feature-123.yml

# Extract and validate a plan from a file
rmplan extract output.txt --output plan.yml

# Extract a plan from clipboard or stdin. Write to stdout
rmplan extract

# Prepare the next step(s) and build the context with rmfilter
# This automatically passes the prompt output as the instructions to rmfilter
rmplan next plan.yml --rmfilter -- src/**/*.ts

# Include previous steps in the prompt
rmplan next plan.yml --previous

# You can also use plan IDs instead of file paths
rmplan next my-feature-123 --rmfilter

# Mark the next step as done and commit changes
rmplan done plan.yml --commit

# Mark the next 2 steps as done and commit changes
rmplan done plan.yml --commit --steps 2

# You can also use plan IDs instead of file paths
rmplan done my-feature-123 --commit

# Generate detailed steps and prompts for a phase that doesn't have them yet
rmplan prepare plan.yml

# Prepare the next ready plan
rmplan prepare --next

# Force preparation even if dependencies aren't complete
rmplan prepare plan.yml --force

# Generate a research prompt based on a plan's goals and details
rmplan research plan.yml

# Generate research prompt with file context using rmfilter
rmplan research plan.yml --rmfilter -- src/**/*.ts --grep auth

# Research using plan ID instead of file path
rmplan research my-feature-123 --rmfilter -- docs/architecture.md

# Create a new plan stub file with a title and optional metadata
rmplan add "Implement OAuth authentication" --output tasks/oauth-auth.yml

# Create a plan with dependencies
rmplan add "Add user roles" --depends-on oauth-auth --output tasks/user-roles.yml

# Create a high-priority plan and open in editor
rmplan add "Fix security vulnerability" --priority high --edit

# Split a large plan into phase-based plans using an LLM
rmplan split tasks/large-feature.yml --output-dir ./feature-phases

# Split and include specific documentation for context
rmplan split tasks/complex-refactor.yml --output-dir ./refactor-phases -- docs/architecture.md

# Update an existing plan with natural language changes
rmplan update tasks/feature.yml "Add error handling to the API calls"

# Update using direct mode (runs LLM automatically)
rmplan update tasks/feature.yml "Add error handling" --direct --model claude-3-5-sonnet-20241022

# Update using plan ID and open editor for description
rmplan update my-feature-123 --editor

# Update with additional context from rmfilter
rmplan update tasks/feature.yml "Remove the database migration task" -- src/**/*.ts

# List all plan files in the tasks directory (shows pending and in_progress by default)
rmplan list

# List all plans including completed ones
rmplan list --all

# List only plans with specific statuses
rmplan list --status done
rmplan list --status pending in_progress

# List plans with custom sorting
rmplan list --sort status --reverse

# List plans from a specific directory
rmplan list --dir ./my-plans

# Show detailed information about a plan
rmplan show plan.yml

# Show plan information using its ID
rmplan show my-feature-123

# Show the next plan that is ready to be implemented
rmplan show --next

# Show the next ready dependency of a parent plan
rmplan show --next-ready 100

# Automatically execute steps in a plan, choosing a specific model
rmplan agent plan.yml --model google/gemini-2.5-flash-preview-05-20
# Or use the 'run' alias
rmplan run plan.yml --model google/gemini-2.5-flash-preview-05-20

# Execute a specific number of steps automatically
rmplan agent plan.yml --steps 3

# Execute the next ready plan (pending with all dependencies complete)
rmplan agent --next
# Or using the run alias
rmplan run --next

# Execute plan with auto-created workspace
rmplan agent plan.yml --workspace-task-id task-123

# You can also use plan IDs instead of file paths
rmplan agent my-feature-123 --steps 3

# Clean up end-of-line comments from changed files (by git diff, jj diff)
rmplan cleanup

# Cleanup end-of-line comments in all files modified compared to a base branch
rmplan cleanup --diff-from main

# Clean up end-of-line comments from specific files
rmplan cleanup src/lib/utils.ts src/components/Button.svelte

# Answer PR review comments, automatically detecting the current PR
rmplan answer-pr

# Answer PR review comments for a specific PR
rmplan answer-pr dimfeld/llmutils#82

# List all workspaces and their lock status
rmplan workspace list

# List workspaces for a specific repository
rmplan workspace list --repo https://github.com/dimfeld/llmutils.git

# Create a new workspace without associating it with a plan
rmplan workspace add

# Create a workspace with a specific ID
rmplan workspace add --id my-custom-ws

# Create a workspace and associate it with a plan by file path
rmplan workspace add path/to/my-plan.yml

# Create a workspace with a plan by ID and a custom workspace ID
rmplan workspace add my-plan-id --id my-dev-space
```

## Working with Plan Dependencies

The `--next-ready` feature enables automated workflow management for complex, multi-phase projects by automatically finding the next actionable task in your dependency chain. This eliminates the need to manually track which plans are ready to work on, allowing you to focus on implementation rather than project coordination.

### Overview

When working with large projects, you often break work into phases with clear dependencies:

- Phase 1: Database schema → Phase 2: API endpoints → Phase 3: Frontend components
- Phase 4: Authentication (parallel to Phase 1) → Phase 5: Auth integration (depends on Phase 3 & 4)

The `--next-ready` flag automatically traverses your dependency graph using breadth-first search to find the next plan that is ready to be implemented (all dependencies complete, has actionable tasks, appropriate priority).

### Key Benefits

- **Automated Discovery**: No manual tracking of which plans are ready
- **Intelligent Prioritization**: Considers status, priority level, and plan ID for consistent ordering
- **Comprehensive Feedback**: Clear explanations when no ready dependencies exist
- **Seamless Integration**: Works with all existing rmplan commands and options

### Usage Examples

#### Basic Dependency Workflow

```bash
# Show the next ready dependency without executing
rmplan show --next-ready 100
# Output: Found ready plan: Database Schema Setup (ID: 101)

# Generate planning prompt for the next ready dependency
rmplan generate --next-ready 100 -- src/database/**/*.ts
# Operates on plan 101 instead of 100

# Prepare detailed steps for the ready dependency
rmplan prepare --next-ready 100 --direct

# Execute the next ready dependency automatically
rmplan agent --next-ready 100
# or using the run alias
rmplan run --next-ready 100
```

#### Integration with Existing Options

```bash
# Generate with file context and auto-commit
rmplan generate --next-ready parent-plan --commit -- src/**/*.ts --grep auth

# Execute with workspace isolation and specific step count
rmplan agent --next-ready 100 --workspace feature-work --steps 2

# Use Claude Code executor for the ready dependency
rmplan run --next-ready 100 --executor claude-code --dry-run

# Prepare with custom model
rmplan prepare --next-ready parent-plan --claude --direct
```

#### Continuous Workflow

```bash
# 1. Start with parent plan containing dependencies
rmplan show 100
# Parent Plan: "User Authentication System" (5 dependencies)

# 2. Work on first ready dependency
rmplan agent --next-ready 100
# Executes: "Database Schema Setup" (ID: 101)

# 3. After completion, next dependency becomes ready
rmplan show --next-ready 100
# Found ready plan: API Endpoints (ID: 102)

# 4. Continue until all dependencies complete
rmplan agent --next-ready 100
# Executes: "API Endpoints" (ID: 102)

# 5. Eventually returns to parent plan
rmplan show --next-ready 100
# All dependencies complete - ready to work on parent plan
```

### Error Handling and Feedback

The feature provides detailed guidance when dependencies aren't ready:

```bash
# No dependencies exist
rmplan show --next-ready 100
# → No dependencies found for this plan

# All dependencies complete
rmplan show --next-ready 100
# → All dependencies are complete - ready to work on the parent plan

# Dependencies need preparation
rmplan show --next-ready 100
# → 2 dependencies have no actionable tasks
# → Try: Run 'rmplan prepare' to add detailed steps

# Dependencies are blocked
rmplan show --next-ready 100
# → 3 dependencies are blocked by incomplete prerequisites
# → Try: Work on the blocking dependencies first
```

### Organizing Plans for Dependencies

To maximize effectiveness:

**1. Clear Dependency Chains**

```yaml
# Child plans specify their dependencies
id: 102
title: 'API Endpoints'
dependencies: [101] # Depends on Database Schema (101)
parent: 100 # Part of larger feature (100)
```

**2. Appropriate Priorities**

```yaml
priority: high    # Critical path items
priority: medium  # Normal implementation
priority: low     # Nice-to-have features
priority: maybe   # Optional (excluded from --next-ready)
```

**3. Prepared Tasks**

```bash
# Ensure dependencies have actionable tasks
rmplan prepare 101  # Database schema
rmplan prepare 102  # API endpoints
rmplan prepare 103  # Frontend components

# Now --next-ready can execute them automatically
rmplan agent --next-ready 100
```

### Debugging

Use `--debug` to see detailed dependency discovery logging:

```bash
rmplan show --next-ready 100 --debug
# Shows: BFS traversal, filtering decisions, readiness checks, sorting logic
```

#### Workspace Commands

##### Workspace List

The `workspace list` command displays all workspaces and their lock status for a repository. This helps you track which workspaces are in use and identify any stale locks.

**Syntax:** `rmplan workspace list [--repo <url>]`

**Options:**

- `--repo <url>`: Filter by repository URL. If not specified, uses the current repository.

**Output includes:**

- Lock status (🔒 for locked, 🔓 for available)
- Workspace path
- Associated task ID
- Branch name
- Creation timestamp
- For locked workspaces: PID, hostname, and lock age in hours

##### Workspace Add

The `workspace add` command allows you to manually create and initialize a new workspace. This provides explicit control over workspace creation, which is particularly useful when you want to set up a workspace environment before running an agent or for tasks not yet defined by a formal plan file.

**Key Features:**

- Create workspaces with or without associating them to a plan
- Optionally specify a custom workspace ID
- When a plan is associated, the plan's status is automatically updated to `in_progress` in both the original location and the new workspace
- The plan file is copied into the new workspace when associated

**Syntax:** `rmplan workspace add [planIdentifier] [--id <workspaceId>]`

**Options:**

- `planIdentifier` (optional): Can be either a plan ID or file path. If provided, the workspace will be associated with this plan.
- `--id <workspaceId>` (optional): Specify a custom workspace ID. If not provided, a unique ID will be automatically generated.

**Usage Examples:**

```bash
# Create a workspace without a plan
rmplan workspace add

# Create a workspace with a specific ID, no plan
rmplan workspace add --id my-custom-ws

# Create a workspace and associate it with a plan by file path
rmplan workspace add path/to/my-plan.yml

# Create a workspace with a plan by ID and a custom workspace ID
rmplan workspace add my-plan-id --id my-dev-space
```

**Behavior:**

- When no plan is specified, creates an empty workspace ready for manual use
- When a plan is specified:
  - The plan file is resolved (by ID or path)
  - Its status is updated to `in_progress` in the current context
  - The plan file is copied to the new workspace
  - The plan's status in the new workspace is also set to `in_progress`
- All workspaces are tracked in `~/.config/rmfilter/workspaces.json`

#### Cleanup Command

The `cleanup` command removes end-of-line comments (comments that appear after code on the same line) from files. It supports `.svelte`, `.js`, `.ts`, `.py`, and `.rs` files and is useful for removing redundant comments often added by LLMs, such as `// import x` after an import statement.

By default, it processes all changed files in the current revision. You can use the `--diff-from` option to specify a different base for determining changed files.

**Usage Examples:**

```bash
# Remove end-of-line comments from all changed files in the current revision
rmplan cleanup

# Remove end-of-line comments compared to a specific branch
rmplan cleanup --diff-from feature-branch

# Remove end-of-line comments from specific files
rmplan cleanup src/lib/utils.ts src/components/Button.svelte
```

**Notes:**

- The command only removes comments that appear after code on the same line, preserving standalone comment lines and empty lines.
- Files must exist and have a supported extension to be processed.
- Use `--diff-from` to specify a different base branch for determining changed files when no files are provided.

### Requirements

- Set the `GOOGLE_GENERATIVE_AI_API_KEY` environment variable to use the extract command.

### Notes

- The `--rmfilter` option requires additional arguments for `rmfilter` (passed after `--`).
- Use `--previous` to include completed steps for context in the LLM prompt.
- The `--commit` option supports both git and jj for version control.
- The `agent` command automates step execution, using `rmfilter` to generate context, running the step with an LLM, and marking it as done with a commit. It stops on errors or when the plan is complete.

### Configuration

`rmplan` can be configured using a YAML file to customize its behavior.

- **Location**: By default, `rmplan` looks for a configuration file at `.rmfilter/config/rmplan.yml` relative to the Git repository root.
- **Override**: You can specify a different configuration file using the global `--config <path>` option.
- **Schema**: The configuration format is defined by a JSON schema, available at `https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-config-schema.json`. You can reference this schema in your YAML file for editor support:
  ```yaml
  # yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-config-schema.json
  ```

#### Paths

The `paths.tasks` setting allows you to specify the directory where the task documents are locations. This is used when automatically
writing a plan from a GitHub issue.

#### Documentation Search Paths

The `paths.docs` setting allows you to specify additional directories where `rmfilter` should search for `.md` and `.mdc` documentation files to auto-include. This extends the default MDC file search behavior to include custom documentation directories.

**Configuration in `rmplan.yml`:**

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-config-schema.json

paths:
  docs:
    - ./docs # Search in docs/ directory
    - ./project-docs # Search in project-docs/ directory
    - ../shared-docs # Can also reference directories outside the repo
```

**Key Features:**

- **Automatic MDC/MD File Discovery**: Searches specified directories and their subdirectories for `.md` and `.mdc` files
- **Frontmatter Support**: Files must have valid YAML frontmatter to be processed
- **Grep Term Matching in Instructions**: MDC files with `grep` terms will now also match if those terms appear in the instructions passed to `rmfilter`, not just in source files
- **Seamless Integration**: Works alongside the existing MDC file search in `.cursor/rules/` and `~/.config/rmfilter/rules/`

**How It Works:**

1. When `rmfilter` runs, it loads the rmplan configuration to find any configured docs paths
2. It searches these directories for `.md` and `.mdc` files with frontmatter
3. Files are filtered based on their frontmatter rules (globs, grep terms, alwaysApply)
4. Grep terms are now matched against both:
   - The instructions text provided to `rmfilter`
   - The content of source files (as before)
5. Matching documentation is included in the output

This feature is particularly useful for:

- Maintaining project-specific documentation that should be included based on the task at hand
- Sharing documentation across multiple projects
- Organizing documentation outside of the `.cursor` directory structure
- Including relevant documentation when specific terms appear in your instructions

#### Workspace Auto-Creation

The `workspaceCreation` section allows you to configure how `rmplan agent` automatically creates isolated workspaces for tasks. This feature provides a clean, dedicated environment for each task execution, avoiding conflicts with other work in your main repository.

**Configuration in `rmplan.yml`:**

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-config-schema.json

workspaceCreation:
  method: 'rmplan'
  repositoryUrl: 'https://github.com/username/repo.git' # Optional, inferred from current repo if not specified
  cloneLocation: '/path/to/workspaces' # Required: location for new workspaces
  postCloneCommands: # Commands to run after cloning (optional)
    - 'npm install'
    - 'npm run build'
```

**Key Features:**

- **Automatic Workspace Management**:
  - Automatically clones your repository
  - Creates a task-specific branch
  - Runs configurable post-clone commands
  - Tracks workspaces in `~/.config/rmfilter/workspaces.json`

- **Required Configuration**:
  - `cloneLocation` must be specified in the configuration
  - Repository URL can be inferred from the current Git repository or explicitly set

**Usage:**

```bash
# Create a workspace with a specific task ID
rmplan agent plan.yml --workspace-task-id my-feature-123

# The agent runs in the new workspace automatically
```

**Workspace Tracking:**

Workspaces are tracked in `~/.config/rmfilter/workspaces.json`, which maintains a record of:

- The task ID each workspace was created for
- The absolute path to each workspace
- Creation timestamp
- Original repository URL

This tracking allows for workspace reuse when the same task ID is specified multiple times.

#### Automatic Examples

When `autoexamples` is set, rmplan will search the generated prompt
for the provided values, and when it runs `rmfilter`, matching values will be automatically added
as `--example` options to the command line for all matching strings.

This can help the coding model to see the proper patterns for using particular pieces of code.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-config-schema.json

autoexamples:
  - PostgresTestEnvironment
  # Find Select, but pass "<Select" to rmfilter so that we will be sure to get a component tag
  - find: Select
    example: <Select
```

#### Post-Apply Commands

The `postApplyCommands` setting allows you to define commands that should be executed automatically by the `rmplan agent` after it successfully applies changes from the LLM but _before_ it marks the step as done and commits. This is useful for tasks like code formatting or linting.

**Example `.rmfilter/config/rmplan.yml`:**

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-config-schema.json

postApplyCommands:
  - title: Format Code # User-friendly title for logging
    command: bun run format # The command string to execute
    allowFailure: true # Optional: If true, the agent continues even if this command fails (default: false)
    hideOutputOnSuccess: true # Optional: Show output only if the command fails
    # workingDirectory: sub/dir # Optional: Run command in a specific directory relative to repo root (default: repo root)
    # env: # Optional: Environment variables for the command
    #   NODE_ENV: production

  - title: Run Linters
    command: bun run lint --fix
    allowFailure: false # Default behavior: agent stops if command fails
```

**Fields:**

- `title`: (Required) A short description logged when the command runs.
- `command`: (Required) The command line string to execute.
- `allowFailure`: (Optional) Boolean, defaults to `false`. If `false`, the agent will stop if the command exits with a non-zero status.
- `hideOutputOnSuccess`: (Optional) Boolean, defaults to `false`. If `true`, the command's output is displayed only if it fails.
- `workingDirectory`: (Optional) String path relative to the repository root where the command should be executed. Defaults to the repository root.
- `env`: (Optional) An object mapping environment variable names to string values for the command's execution context.

#### Model API Keys

The `modelApiKeys` setting allows you to specify custom environment variables for API keys on a per-model or per-provider basis. This is useful when you need to use different API keys for different models or when your API keys are stored in non-standard environment variables.

**Example `.rmfilter/config/rmplan.yml`:**

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-config-schema.json

modelApiKeys:
  # Use a specific environment variable for all OpenAI models
  'openai/': 'MY_OPENAI_API_KEY'

  # Use a different key for a specific model
  'anthropic/claude-3.5-sonnet': 'CLAUDE_SONNET_KEY'

  # General key for other Anthropic models
  'anthropic/': 'MY_ANTHROPIC_KEY'

  # Keys for other providers
  'groq/': 'GROQ_API_KEY'
  'cerebras/': 'CEREBRAS_KEY'
```

**How It Works:**

1. When creating a model instance, rmplan checks the `modelApiKeys` configuration
2. It first looks for an exact match (e.g., `anthropic/claude-3.5-sonnet`)
3. If no exact match is found, it looks for a prefix match (e.g., `anthropic/`)
4. If a match is found, it uses the specified environment variable instead of the default
5. If the custom environment variable is not set, it falls back to the provider's default environment variable

**Notes:**

- Exact matches take precedence over prefix matches
- Google Vertex AI doesn't use API keys, so any custom key configuration for `vertex/` providers will be ignored
- If a custom environment variable is specified but not found, the system will fall back to the default environment variable for that provider

#### answer-pr Configuration

The `answerPr` section allows you to set default values for the `rmplan answer-pr` command. These defaults are used when the corresponding command-line options are not explicitly provided.

**Example `.rmfilter/config/rmplan.yml`:**

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-config-schema.json

answerPr:
  # Default mode for handling PR comments
  # Options: 'inline-comments', 'separate-context', 'hybrid'
  mode: hybrid

  # Whether to automatically commit changes after processing
  commit: true

  # Whether to post replies to review threads after committing
  comment: true
```

**Fields:**

- `mode`: (Optional) The default mode for handling PR comments. Options are:
  - `inline-comments`: Inserts AI comment markers directly into the code files
  - `separate-context`: Includes PR comments as separate context in the prompt
  - `hybrid`: Combines both approaches for maximum context
- `commit`: (Optional) Boolean, defaults to `false` if not specified. When `true`, automatically commits changes after processing
- `comment`: (Optional) Boolean, defaults to `false` if not specified. When `true`, posts replies to handled review threads after committing

**How It Works:**

1. When you run `rmplan answer-pr` without specifying options, the command checks the configuration
2. For any option not provided on the command line, it uses the value from the configuration
3. Command-line options always take precedence over configuration defaults
4. If neither command-line nor configuration provides a value, built-in defaults are used

**Example Usage:**

```bash
# With the above configuration, this command:
rmplan answer-pr

# Is equivalent to:
rmplan answer-pr --mode hybrid --commit --comment

# But you can still override individual options:
rmplan answer-pr --mode inline-comments  # Uses inline-comments mode but keeps commit and comment from config
```

### Executors

The executor system in rmplan provides a flexible way to execute plan steps with different AI models or tools. Executors handle the interaction with language models, applying edits to the codebase, and integrating with external tools.

#### Available Executors

- **CopyPasteExecutor (default)**: Copies the prompt to the clipboard for you to paste into a web UI and then manually apply the model's response.

- **OneCallExecutor**: Sends the prompt to an API-accessible LLM directly without user intervention.

- **CopyOnlyExecutor**: Just copies the prompt to the clipboard without applying any edits.

- **ClaudeCodeExecutor**: Executes the plan using Claude Code CLI, providing an agent-based approach that can read files, apply edits, and run commands directly.

To specify an executor, use the `--executor` option:

```bash
# Use Claude Code to execute the plan
rmplan agent plan.yml --executor claude-code

# Use direct API calls to execute the plan
rmplan agent plan.yml --executor direct-call
```

### Claude Code Executor: Interactive Tool Permissions

**Note**: The interactive permission system is disabled by default. To enable it, set the `CLAUDE_CODE_PERMISSIONS` environment variable to `true` or configure it in your rmplan configuration file:

```yaml
# In .rmfilter/config/rmplan.local.yml
executors:
  claude-code:
    permissionsMcp:
      enabled: true
```

When enabled, the Claude Code executor includes an interactive permission system that allows you to control which tool invocations are automatically approved. When Claude attempts to use a tool during execution, you'll see a permission prompt with three options:

- **Allow**: Permits this specific tool invocation only
- **Disallow**: Denies this specific tool invocation
- **Always Allow**: Permanently approves this tool (or command prefix for Bash tools) for automatic execution in future sessions

#### Special Handling for Bash Commands

The `Bash` tool receives special treatment due to its powerful nature. When you select "Always Allow" for a Bash command, an interactive prefix selection interface appears:

1. The interface displays command tokens that you can navigate using arrow keys
2. Press the right arrow to include more of the command in the approved prefix
3. Press the left arrow to include less of the command
4. Press 'a' to select all the words in the command
5. Press Enter to confirm your selection

#### Permission Persistence

"Always Allow" rules are automatically saved to the `.claude/settings.local.json` file in your project's root directory. This ensures your preferences persist across sessions.

#### Automatic File Deletion Approval

The Claude Code executor includes an optional feature to automatically approve deletion of files that were created or modified by Claude Code within the same session. This reduces the number of manual approvals needed for routine cleanup tasks.

To enable this feature, configure the `autoApproveCreatedFileDeletion` option in your rmplan configuration file:

```yaml
# In .rmfilter/config/rmplan.local.yml
executors:
  claude-code:
    permissionsMcp:
      autoApproveCreatedFileDeletion: true
```

**How it works:**

- When enabled, Claude Code tracks all files that are created or modified using the `Write`, `Edit`, or `MultiEdit` tools during the session
- If Claude Code attempts to run `rm <path>` or `rm -f <path>` on any of these tracked files, the command is automatically approved
- When a deletion is auto-approved, a log message is displayed indicating which file was automatically approved for deletion
- Files not created or modified by Claude Code in the current session will still require manual approval
- The feature is disabled by default (`false`) for security

This feature is particularly useful when Claude Code creates temporary test files, configuration files, or other artifacts that need to be cleaned up as part of the implementation process.

## Multi-Phase Project Planning

The `rmplan` utility supports a detailed planning mode that enables breaking large software features into phases, with each phase delivering a working component that builds on previous phases. This approach ensures incremental, validated progress through complex implementations.

### Overview

Phase-based planning is designed for projects that are too large or complex to implement in a single pass. Instead of generating all implementation details upfront, this mode:

- Breaks the project into distinct phases, each with clear goals and deliverables
- Generates high-level plans first, then creates detailed implementation steps for each phase as needed
- Ensures each phase delivers working functionality that can be tested and merged
- Tracks dependencies between phases to ensure proper sequencing

### Workflow

The multi-phase workflow consists of three main commands:

1. **`rmplan generate --input plan.md --output feature_plan.md`**: Generates a high-level markdown plan with phases. This command now outputs a structured markdown document containing:
   - Overall project goal and details
   - Multiple phases, each with goals, dependencies, and high-level tasks

2. **`rmplan parse --input feature_plan.md --output-dir ./my_feature_plan`**: Parses the markdown plan into individual phase YAML files. This creates a directory structure with one YAML file per phase.

3. **`rmplan generate-phase --phase ./my_feature_plan/my_project_id/phase_1.yaml`**: Generates detailed implementation steps for a specific phase. This populates the phase YAML with concrete prompts, file lists, and other details needed for execution.

**Alternative approach with `split`**: If you already have a detailed, single-file plan that has grown too large or complex, you can use the `rmplan split` command to intelligently break it down into phase-based plans. This command uses an LLM to analyze the existing tasks and create a logical phase structure with proper dependencies, preserving all the original task details.

The iterative process is:

- Generate the overall plan
- Parse it into phases
- For each phase: generate details → implement → review → merge
- Proceed to the next phase only after the previous one is complete

### File Structure

After parsing a multi-phase plan, you'll have this structure:

```
project-directory/
├── plan.md                  # Original input for `rmplan generate`
├── feature_plan.md          # Generated phase-based markdown plan
└── my_feature_plan/         # Directory specified in `rmplan parse --output-dir`
    └── my_project_id/       # Directory named after the auto-generated/specified project ID
        ├── phase_1.yaml
        ├── phase_2.yaml
        └── ...
```

### Markdown Plan Structure

The generated markdown plan (`feature_plan.md`) follows this structure:

```markdown
## Project Goal

[Overall project description]

## Project Details

[Additional context and requirements]

### Phase 1: [Phase Title]

#### Goal

[What this phase accomplishes]

#### Dependencies

- None (for first phase)
- Phase X: [Dependency description] (for later phases)

#### Details

[Phase-specific context]

##### Task: [Task Title]

[High-level task description without implementation details]
```

### Phase YAML Structure

Each phase YAML file follows the standard `planSchema` with these key differences:

- Tasks initially have empty `steps[]` arrays
- `projectId` links all phases together
- `phaseId` identifies the specific phase
- Dependencies are tracked in the phase metadata

The `rmplan generate-phase` command populates the empty `steps[]` with detailed implementation instructions.

### Project Naming

The `projectId` is automatically determined in this order:

1. From a GitHub issue number (if using `--issue`)
2. Auto-generated using a timestamp-based ID

### Single-Phase Projects

If the generated markdown plan contains no `### Phase X` headers, `rmplan parse` treats it as a single-phase project, maintaining backward compatibility with existing workflows.

### Error Handling

The system includes robust error handling:

- Invalid markdown structure saves the raw content for manual correction
- Parsing errors save partial outputs to disk
- LLM response errors save the raw response for inspection
- All error outputs include helpful messages about next steps

## answer-pr

The `rmplan answer-pr` command helps handle GitHub pull request review comments using language models. It can fetch PR comments, let you select which ones to address, and automate responses with AI assistance.

### Key Features {#key-features-4}

- **PR Comment Selection**: Fetch and interactively select which PR comments to address.
- **Automatic PR Detection**: Automatically detect the current PR from your branch.
- **Comment Modes**: Choose between inline comment markers or separate context for addressing feedback.
- **Integration with Executors**: Use the same executor system as rmplan for applying changes.
- **Automatic Replies**: Optionally post replies to the handled threads after committing changes.
- **Special Comment Options**: Parse special options from PR comments to customize how they're handled.

### Usage

Handle PR comments with AI assistance:

```bash
# Automatically detect the current PR and address comments
rmplan answer-pr

# Answer comments for a specific PR
rmplan answer-pr dimfeld/llmutils#82

# Use specific options (disable interactive mode and autocommit)
rmplan answer-pr --yes --commit

# Use Claude Code as the executor
rmplan answer-pr --executor claude-code

# Post replies to review threads after committing
rmplan answer-pr --commit --comment

# Dry run (prepare the prompt without executing)
rmplan answer-pr --dry-run
```

### Options Editor

When handling PR comments, an interactive options editor allows you to adjust settings before generating and executing the LLM prompt:

- **Change LLM model**: Select a different model for addressing the comments.
- **Edit rmfilter options**: Add or modify context-gathering options.
- **Toggle autocommit**: Enable or disable automatically committing changes.
- **Toggle review thread replies**: Enable or disable posting replies to review threads.

You can also include special options in PR comments to customize how they're handled:

```
Add validation here for user input

rmpr: with-imports
rmpr: include src/forms
```

## Usage Examples

### Using rmfilter

Filter and process files in your repository with various options:

```bash
# Basic file filtering with multiple globs
rmfilter src/**/*.ts tests/**/*.ts

# Use repo: prefix to specify paths relative to the git root
rmfilter repo:src/lib/auth.ts repo:src/routes/admin \
  --grep users --grep email --with-imports \
  --instructions 'Add a checkbox to the "add a user" sheet that determines whether or not a verification email is sent. Set verified=true and skip sending the email when the checkbox is not set. It should be set by default' --copy

# Use pkg: prefix in a monorepo to specify paths relative to the package, if the CWD is inside a package
rmfilter pkg:lib/utils.ts package:tests/utils.test.ts \
  --grep "util" --copy

# Filter with multiple grep patterns and case expansion
rmfilter --grep "function" --grep "class" --expand src/**/*.ts

# Include full import tree and limit to largest files
rmfilter --with-all-imports --largest 5 src/lib/*.ts

# Filter with examples, test files, and custom output
rmfilter --example "fetchData" --example-file "fetch=src/api/fetchData.ts" --with-tests --output filtered.txt src/**/*.ts

# Process files with diff and custom instructions
rmfilter --with-diff --instructions "Optimize all functions" src/**/*.ts

# Multiple commands with different filters. Copy output to clipboard
rmfilter src/lib/*.ts --grep "export" -- src/tests/*.ts --grep "labels" \
  --instructions 'Add a field to a class' --copy

# Open instructions in the editor
rmfilter src/**/*.ts --instructions-editor --copy
```

### Using rmplan

Generate and manage project plans:

```bash
# Read a project description, and create a detailed plan for implementing it
rmplan generate --plan tasks/0002-refactor-it.md -- src/api/**/*.ts

# Or read the plan from a Github issue
rmplan generate --issue 28 -- src/api/**/*.ts

# Generate a plan for the next ready dependency of a parent plan
rmplan generate --next-ready 100 -- src/api/**/*.ts

# Import GitHub issues as stub plans for later detailed planning
rmplan import --issue 123
rmplan import  # Interactive mode to select multiple issues

# Read the plan from the clipboard, convert to YAML, and write to a file
# Note: The `generate` command will do this automatically if you want.
rmplan extract --output tasks/0002-refactor-it.yml

# Execute the next step with repository context
rmplan next tasks/0002-refactor-it-plan.yml --rmfilter -- src/api/**/*.ts --grep fetch

# Mark multiple steps as done and commit
rmplan done tasks/0002-refactor-it-plan.yml --steps 2 --commit

# Or Automatically execute all the steps in a plan
rmplan agent tasks/0002-refactor-it-plan.yml

# Automatically execute steps using a custom configuration file
rmplan agent tasks/0003-new-feature.yml --config path/to/my-rmplan-config.yml

# Execute the next ready dependency of a parent plan automatically
rmplan agent --next-ready 100

# Use Claude Code executor for a more integrated experience
rmplan agent tasks/0003-new-feature.yml --executor claude-code

# Execute a plan in a newly created, isolated workspace
rmplan agent tasks/my-feature.yml --workspace-task-id feature-xyz

# Create new plan stubs for quick capture of future work
rmplan add "Implement user authentication" --output tasks/auth.yml
rmplan add "Add logging system" --depends-on auth --priority medium --edit

# Split a complex plan into manageable phases
rmplan split tasks/big-refactor.yml --output-dir ./refactor-phases

# Update an existing plan with new requirements
rmplan update tasks/feature.yml "Add a new task for database setup and remove the placeholder task"

# Update using direct mode with a specific model
rmplan update tasks/feature.yml "Add error handling" --direct --model gpt-4o

# Update a plan using an editor for the description
rmplan update 123.yml --editor

# Multi-phase planning workflow
# 1. Generate a phase-based plan
rmplan generate --input tasks/large-feature.md --output tasks/large-feature-plan.md -- src/**/*.ts

# 2. Parse the markdown plan into phase YAML files
rmplan parse --input tasks/large-feature-plan.md --output-dir ./large-feature-phases

# 3. Generate detailed steps for the first phase
rmplan generate-phase --phase ./large-feature-phases/project-xyz/phase_1.yaml

# 4. Execute the phase (using any of the execution methods)
rmplan agent ./large-feature-phases/project-xyz/phase_1.yaml
```

### Using answer-pr

Handle PR comments:

```bash
# Detect the current PR and handle comments
rmplan answer-pr

# Handle comments for a specific PR
rmplan answer-pr 82

# Use Claude Code executor and autocommit
rmplan answer-pr --executor claude-code --commit

# Commit and reply to comments
rmplan answer-pr --commit --comment
```

### Applying LLM Edits

Process LLM-generated edits from different sources:

```bash

# Apply edits from clipboard (works in both local and SSH sessions thanks to OSC52 support)
rmfilter src/**/*.ts --copy
apply-llm-edits

# Apply edits from stdin with custom working directory
cat edits.txt | apply-llm-edits --stdin --cwd

# Dry run to preview changes
apply-llm-edits --dry-run

# Run and apply in one go
rmfilter src/**/*.ts --instructions 'Make it better'
rmrun
```

## Acknowledgements

- [repomix](https://github.com/yamadashy/repomix) and [ripgrep](https://github.com/BurntSushi/ripgrep) provide a lot of
  the internal functionality.
- The editor prompts and much of the code for applying edits are from [Aider](https://github.com/Aider-AI/aider).
- The plan generation prompt is adapted from https://harper.blog/2025/02/16/my-llm-codegen-workflow-atm/
