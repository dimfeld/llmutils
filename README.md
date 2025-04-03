# llmutils

Command-line utilities for managing context with chat-oriented programming, and applying edits back.

This is unoptimized and a bit of a mess right now, but overall works well for collecting a relevant set of files when
you know a good starting point.

The two scripts are:
- rmfilter: A wrapper around repomix which can analyze import trees to gather all the files referenced by a root file, and add instructions and other rules to the repomix output. Supports both "whole file" and "diff" edit modes.
- apply-llm-edits: Once you've pasted the rmfilter output into a chat model and get the output, you can use this script to apply the edits back to your codebase.


## Installation

This project uses [Bun](https://bun.sh) as its runtime and package manager.

### Prerequisites
- Bun (version 1.x or higher)
- Git

### Build Instructions
1. Clone the repository:
```bash
git clone https://github.com/dimfeld/llmutils.git
cd llmutils
```

2. Install dependencies:
```bash
bun install
```

3. Install globally:
```bash
pnpm add -g .
```

## Usage Examples

### Using rmfilter
Filter and process files in your repository with various options:

```bash
# Basic file filtering with multiple globs
rmfilter src/**/*.ts tests/**/*.ts

# Filter with multiple grep patterns and case expansion
rmfilter --grep "function" --grep "class" --expand src/**/*.ts

# Include full import tree and limit to largest files
rmfilter --with-all-imports --largest 5 src/lib/*.ts

# Filter with examples and custom output
rmfilter --example "fetchData" --example "processResponse" --output filtered.txt src/**/*.ts

# Process files with diff and custom instructions
rmfilter --with-diff --instructions "Optimize all functions" src/**/*.ts

# Multiple commands with different filters
rmfilter src/lib/*.ts --grep "export" -- src/tests/*.ts --grep "labels"
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

