# llmutils

Command-line utilities for managing context with chat-oriented programming, and applying edits back.

This is unoptimized and a bit of a mess right now, but overall works well for collecting a relevant set of files when
you know a good starting point.

The scripts are:

- `rmfilter` - A wrapper around repomix which can analyze import trees to gather all the files referenced by a root file, and add instructions and other rules to the repomix output. Supports both "whole file" and "diff" edit modes.
- `apply-llm-edits` - Once you've pasted the rmfilter output into a chat model and get the output, you can use this script to apply the edits back to your codebase.
- `rmrun` - Send the rmfilter output to a language model and apply the edits back.
- `rmfind` - Find relevant files to use with rmfilter

Some of the features, such as dependency analysis, only work with the code I've been writing at work recently, and so
assume a repository written with Typescript and PNPM workspaces.

## Installation

This project assumes you have these tools installed:

- [Bun](https://bun.sh/)
- [ripgrep](https://github.com/BurntSushi/ripgrep)
- [repomix](https://github.com/yamadashy/repomix)
- [llm](https://llm.datasette.io/en/stable/index.html)
- [fzf](https://github.com/junegunn/fzf) (for rmfind)
- [bat](https://github.com/sharkdp/bat)

### Build Instructions

Clone the repository, install dependencies, and then install globally:

```bash
git clone https://github.com/dimfeld/llmutils.git
cd llmutils
bun install
pnpm add -g .
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
# Find TypeScript files in src/ and select interactively with fzf
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

### Applying LLM Edits

Process LLM-generated edits from different sources:

```bash
# Apply edits from clipboard
rmfilter src/**/*.ts --copy
apply-llm-edits

# Apply edits from stdin with custom working directory
cat edits.txt | apply-llm-edits --stdin --cwd}

# Dry run to preview changes
apply-llm-edits --dry-run

# Run and apply in one go
rmfilter src/**/*.ts --instructions 'Make it better'
rmrun
```

## TODO

- rmfind: take a natural language query and generate grep terms from that

## Acknowledgements

- [repomix](https://github.com/yamadashy/repomix) and [ripgrep](https://github.com/BurntSushi/ripgrep) provide a lot```bash
git clone https://github.com/dimfeld/llmutils.git
cd llmutils
bun install
pnpm add -g .
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
# Find TypeScript files in src/ and select interactively with fzf
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

### Applying LLM Edits

Process LLM-generated edits from different sources:

```bash
# Apply edits from clipboard
rmfilter src/**/*.ts --copy
apply-llm-edits

# Apply edits from stdin with custom working directory
cat edits.txt | apply-llm-edits --stdin --cwd ./src

# Dry run to preview changes
apply-llm-edits --dry-run

# Run and apply in one go
rmfilter src/**/*.ts --instructions 'Make it better'
rmrun
```

## TODO

- rmfind: take a natural language query and generate grep terms from that

## Acknowledgements

- [repomix](https://github.com/yamadashy/repomix) and [ripgrep](https://github.com/BurntSushi/ripgrep) provide a lot of the internal functionality
- The diff editing style prompts and application code are ported from [Aider](https://github.dev/Aider-AI/aider).
