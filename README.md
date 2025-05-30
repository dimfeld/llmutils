# llmutils

Command-line utilities for managing context with chat-oriented programming, and applying edits back.

The scripts are:

- `rmfilter` - A wrapper around repomix which can analyze import trees to gather all the files referenced by a root file, and add instructions and other rules to the repomix output. Supports both "whole file" and "diff" edit modes.
- `apply-llm-edits` - Once you've pasted the rmfilter output into a chat model and get the output, you can use this script to apply the edits back to your codebase.
- `rmrun` - Send the rmfilter output to a language model and apply the edits back.
- `rmfind` - Find relevant files to use with rmfilter
- `rmplan` - Generate and manage step-by-step project plans for code changes using LLMs, with support for creating, validating, and executing tasks. Includes multi-phase planning for breaking large features into incremental deliverables.
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
- [llm](https://llm.datasette.io/en/stable/index.html)
- [fzf](https://github.com/junegunn/fzf) (for rmfind)
- [bat](https://github.com/sharkdp/bat) (for rmfind and rmrun)
- [claude-cli](https://github.com/anthropics/claude-cli) (for Claude Code support)

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
- **YAML Conversion**: Convert the Markdown project plan into a structured YAML format for running tasks.
- **Task Execution**: Execute the next steps in a plan, generating prompts for LLMs and optionally integrating with `rmfilter` for context.
- **Progress Tracking**: Mark tasks and steps as done, with support for committing changes to git or jj.
- **Plan Inspection**: Display detailed information about plans including dependencies with resolution, tasks with completion status, and metadata.
- **Flexible Input**: Accept plans from files, editor input, or clipboard, and output results to files or stdout.
- **Workspace Auto-Creation**: Automatically create isolated workspaces (Git clones or worktrees) for each task, ensuring clean execution environments.

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

**Note**: When working with plan files, you can use either the file path (e.g., `plan.yml`) or the plan ID (e.g., `my-feature-123`) for commands like `done`, `next`, `agent`, `run`, and `prepare`. The plan ID is found in the `id` field of the YAML file and rmplan will automatically search for matching plans in the configured tasks directory.

Alternatively, you can use the `agent` command (or its alias `run`) to automate steps 5 through 7, executing the plan step-by-step with LLM integration and automatic progress tracking.

When running `rmplan next` to paste the prompt into a web chat or send to an API, you should include the --rmfilter option to include the relevant files and documentation in the prompt. Omit this option when using the prompt with Cursor, Claude Code, or other agentic editors because they will read the files themselves.

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

# Automatically execute steps in a plan, choosing a specific model
rmplan agent plan.yml --model google/gemini-2.5-flash-preview-05-20
# Or use the 'run' alias
rmplan run plan.yml --model google/gemini-2.5-flash-preview-05-20

# Execute a specific number of steps automatically
rmplan agent plan.yml --steps 3

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
```

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

# Use Claude Code executor for a more integrated experience
rmplan agent tasks/0003-new-feature.yml --executor claude-code

# Execute a plan in a newly created, isolated workspace
rmplan agent tasks/my-feature.yml --workspace-task-id feature-xyz

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
