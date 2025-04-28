# llmutils

Command-line utilities for managing context with chat-oriented programming, and applying edits back.

The scripts are:

- `rmfilter` - A wrapper around repomix which can analyze import trees to gather all the files referenced by a root file, and add instructions and other rules to the repomix output. Supports both "whole file" and "diff" edit modes.
- `apply-llm-edits` - Once you've pasted the rmfilter output into a chat model and get the output, you can use this script to apply the edits back to your codebase.
- `rmrun` - Send the rmfilter output to a language model and apply the edits back.
- `rmfind` - Find relevant files to use with rmfilter
- `rmplan` - Generate and manage step-by-step project plans for code changes using LLMs, with support for creating, validating, and executing tasks.

Some of the features, such as dependency analysis, only work with the code I've been writing at work recently, and so
assume a repository written with Typescript and PNPM workspaces.

## Installation

This project assumes you have these tools installed:

- [Bun](https://bun.sh/)
- [ripgrep](https://github.com/BurntSushi/ripgrep)
- [repomix](https://github.com/yamadashy/repomix)
- [llm](https://llm.datasette.io/en/stable/index.html)
- [fzf](https://github.com/junegunn/fzf) (for rmfind)
- [bat](https://github.com/sharkdp/bat) (for rmfind and rmrun)

### Build Instructions

Clone the repository, install dependencies, and then install globally:

```bash
git clone https://github.com/dimfeld/llmutils.git
cd llmutils
bun install
pnpm add -g file://$(pwd)
```

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
  - "docs/**/*.md"
rules:
  - ".cursorrules"
commands:
  - globs:
      - "src/api/**/*.ts"
    grep:
      - "fetch"
    with-imports: true
  - globs:
      - "src/tests/api/**/*.ts"
    grep: "test"
    example: "apiTest"
```

This config:
- Sets the edit format to `diff` and copies output to the clipboard.
- Includes instructions for updating API calls and references a file for additional instructions.
- Includes all markdown files in `docs/` and `.cursorrules` for context.
- Defines two commands: one for API source files with `fetch`, including their imports, and another for test files with an example pattern.

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
- **Grep-based Filtering**: MDC files can include a `grep` field (e.g., `grep: superform, supervalidate`) to match source files containing specific terms (case-insensitive). This ensures only relevant MDC files are included.
- **Type Classification**: MDC files can have a `type` field (e.g., `docs` or `rules`) to categorize them as documentation or coding rules. These are organized into `<documents>` or `<rules>` tags in the output, respectively. The default value is `rules`.
- **Suppression Option**: Use the `--no-mdc` CLI flag to disable automatic MDC file processing if needed.

MDC files with both `globs` and `grep` must match both to be included. Note that the `grep` field is unique to this tool, not part of Cursor's implementation. An MDC file with neither `globs` nor `grep` will always be included, unless the `no-mdc` option is passed.

#### MDC File Format

An `.mdc` file is a Markdown-based file with a YAML frontmatter header. Here's an example:

```markdown
---
description: Rules for Svelte components with Superforms
globs: "*.svelte, *.ts" # Or a YAML array
type: docs
grep: superform, supervalidate # Or a YAML array
name: svelte-superform
---
Docs for Superforms would go here
```

- **Frontmatter Fields**: Includes `description` (purpose of the rule), `globs` (file patterns), `grep` (search terms), `type` (docs or rules), and optional fields like `name` or `metadata`.
- **Body**: Contains the rules or documentation in Markdown, often with coding standards or AI instructions.


## rmfind

The `rmfind` utility helps you locate relevant files in your repository using a combination of glob patterns, ripgrep patterns, and natural language queries. It integrates with `fzf` for interactive file selection, allowing you to refine your file list efficiently. The output can be copied to the clipboard and formatted as a space-separated list or YAML array.

### Key Features
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
rmfind src/**/*.ts --query "database migrations" --model google/gemini-2.5-flash-preview-04-17
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

### Key Features
- **Plan Generation**: Create detailed project plans from a text description, breaking down tasks into small, testable steps.
- **YAML Conversion**: Convert the Markdown project plan into a structured YAML format for running tasks.
- **Task Execution**: Execute the next steps in a plan, generating prompts for LLMs and optionally integrating with `rmfilter` for context.
- **Progress Tracking**: Mark tasks and steps as done, with support for committing changes to git or jj.
- **Flexible Input**: Accept plans from files, editor input, or clipboard, and output results to files or stdout.

### Usage

The general usage pattern is that you will:

1. Use the `generate` command to generate a planning prompt.
2. Paste the output of that into a language model. As of April 2025, Google Gemini 2.5 Pro is probably the best choice.
3. Copy its output to the clipboard or a file.
4. Use the `extract` command to extract the plan Markdown to a YAML file.
5. Use the `next` command to get the prompt for the next step(s).
6. Run the prompt with whatever LLM or coding agent you prefer.
7. Use the `done` command to mark the next step(s) as done and commit changes.

Then repeat steps 5 through 7 until the task is done.

Alternatively, you can use the `agent` command to automate steps 5 through 7, executing the plan step-by-step with LLM integration and automatic progress tracking.

Run `rmplan` with different commands to manage project plans:

```bash
# Generate a plan from a text file and pass extra args to rmfilter
rmplan generate --plan plan.txt -- src/**/*.ts --grep auth

# Open an editor to write a plan and generate a prompt
rmplan generate --plan-editor

# Extract and validate a plan from a file
rmplan extract output.txt --output plan.yml

# Extract a plan from clipboard or stdin. Write to stdout
rmplan extract

# Prepare the next step(s) and build the context with rmfilter 
# This automatically passes the prompt output as the instructions to rmfilter
rmplan next plan.yml --rmfilter -- src/**/*.ts

# Include previous steps in the prompt
rmplan next plan.yml --previous

# Mark the next step as done and commit changes
rmplan done plan.yml --commit

# Mark the next 2 steps as done and commit changes
rmplan done plan.yml --commit --steps 2

# Automatically execute steps in a plan, choosing a specific model
rmplan agent plan.yml --model google/gemini-2.5-flash-preview-04-17

# Execute a specific number of steps automatically
rmplan agent plan.yml --steps 3
```

### Requirements

- Set the `GOOGLE_GENERATIVE_AI_API_KEY` environment variable to use the extract command.

### Notes
- The `--rmfilter` option requires additional arguments for `rmfilter` (passed after `--`).
- Use `--previous` to include completed steps for context in the LLM prompt.
- The `--commit` option supports both git and jj for version control.
- The `agent` command automates step execution, using `rmfilter` to generate context, running the step with an LLM, and marking it as done with a commit. It stops on errors or when the plan is complete.

## Usage Examples

### Using rmfilter
Filter and process files in your repository with various options:

```bash
# Basic file filtering with multiple globs
rmfilter src/**/*.ts tests/**/*.ts

# Get relevant files that include the words 'users' or 'email', and the files
# they import.
rmfilter src/routes/admin src/lib/auth.ts src/lib/server/auth \
  --grep users --grep email --with-imports \
   --instructions 'Add a checkbox to the "add a user" sheet that determines whether or not a verification email is sent. Set verified=true and skip sendign the email when the checkbox is not set. It shouldbe set by default' --copy

# Filter with multiple grep patterns and case expansion
rmfilter --grep "function" --grep "class" --expand src/**/*.ts

# Include full import tree and limit to largest files
rmfilter --with-all-imports --largest 5 src/lib/*.ts

# Filter with examples and custom output
rmfilter --example "fetchData" --example "processResponse" --output filtered.txt src/**/*.ts

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

# Read the plan from the clipboard, convert to YAML, and write to a file
rmplan extract --output tasks/0002-refactor-it.yml

# Execute the next step with repository context
rmplan next tasks/0002-refactor-it-plan.yml --rmfilter -- src/api/**/*.ts --grep fetch

# Mark multiple steps as done and commit
rmplan done tasks/0002-refactor-it-plan.yml --steps 2 --commit

# Or Automatically execute all the steps in a plan
rmplan agent tasks/0002-refactor-it-plan.yml
```

### Applying LLM Edits

Process LLM-generated edits from different sources:

```bash

# Apply edits from clipboard
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

