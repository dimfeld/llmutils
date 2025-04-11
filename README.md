# llmutils

Command-line utilities for managing context with chat-oriented programming, and applying edits back.

This is unoptimized and a bit of a mess right now, but overall works well for collecting a relevant set of files when
you know a good starting point.

The two scripts are:

- rmfilter: A wrapper around repomix which can analyze import trees to gather all the files referenced by a root file, and add instructions and other rules to the repomix output. Supports both "whole file" and "diff" edit modes.
- apply-llm-edits: Once you've pasted the rmfilter output into a chat model and get the output, you can use this script to apply the edits back to your codebase.

Some of the features, such as dependency analysis, only work with the code I've been writing at work recently, and so
assume a repository written with Typescript and PNPM workspaces.

## Installation

This project assumes you have these tools installed:

- [Bun](https://bun.sh/)
- [ripgrep](https://github.com/BurntSushi/ripgrep)
- [repomix](https://github.com/yamadashy/repomix)

### Build Instructions

Clone the repository, install dependencies, and then install globally:

```bash
git clone https://github.com/dimfeld/llmutils.git
cd llmutils
bun install
pnpm add -g .
```

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
   --instructions 'Add a checkbox to the "add a user" sheet that determines whetther or not a verification email is sent. Set verified=true and skip sendign the email when the checkbox is not set. It shouldbe set by default' --copy

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
```

## TODO

- [ ] Presets for common things like "Make a PR description given this code and diff"
