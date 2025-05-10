We are creating the rmfix utility, which should run the specified command or npm script from the command line and capture its output. If the command fails, use rmfilter to assemble context to fix the issue with:

- instructions containing the command output and a prompt about fixing the issue
- relevant files gathered by examining the output for source code filenames. Turn this into an rmfilter command including those files and set `--with-imports`.

 Like other commands, anything after the first double-dash should be interpreted as additional `rmfilter` arguments.

Example:
`rmfix test -- libs/db/schema`

Tasks:
- [ ] Run the command given on the command line
- [ ] Detect if the command is an npm script or a regular command.
- [ ] Parse structured test output, supporting TAP, vitest/jest JSON at first
- [ ] Attempt simple regex parse
- [ ] When we don't have a specific format, submit the test output to a lightweight model asking it to find the failures
- [ ] Detect certain test runners and set the reporter for better parsing (e.g. `--reporter json` with running vitest or jest)
- [ ] a command line flag to automatically submit the fix to the model and try to apply any edits in the result (also take an optional model parameter to submit to)
- [ ] If we need a double-dash in the actual test command, then allowusing a triple-slash as the separator for rmfilter commands
- [ ] Have a multiselect that lets you select which failures to try to fix.
- [ ] a command line flag to attempt to fix just: the first failure, the failures for a given test file, or to try to fix everything all at once.
- [ ] exit with the exit code of the underlying command
- [ ] Ability to reference a YAML plan file. This way we can pull in the info about the latest unfinished task which could give a better idea of what the intention was.


# rmfix Specification

## Overview

`rmfix` is a command-line tool and reusable function designed to run a specified command or npm script, capture its output, and, if the command fails, use the `rmfilter` utility to gather context and assist in fixing the issue. It supports parsing structured test output, detecting test runners, and providing options for automated fixing and failure selection.

## Requirements

### Command Execution

- **Languages and Environments**: Primarily targets Node.js but supports running any command-line command.
- **Command Detection**:
    - Checks for the existence of a `package.json` file in the current working directory.
    - If present, parses the `scripts` section to determine if the input command is an npm script.
    - If the command is not found in `scripts` or no `package.json` exists, treats it as a standalone command-line command.
- **Execution Environment**:
    - Inherits the current shell's environment variables.
    - Uses the shell specified in `$SHELL` if set; otherwise, defaults to `sh`.
- **Output Handling**:
    - Streams command output to the console in real-time.
    - Captures output simultaneously for analysis.

### Output Parsing

- **Format Detection**:
    - Auto-detects the output format by attempting to parse in the following order (strictest first):
        1. JSON (Jest/Vitest)
        2. TAP
        3. Other formats (to be defined later, e.g., simple regex for unstructured output).
    - Uses the first format that parses successfully.
    - Provides a CLI flag (e.g., `--format <format>`) to force a specific output format.
- **Fallback Parsing**:
    - For unsupported or unstructured output, submits the output to a lightweight model to identify failures.
- **Test Runner Detection**:
    - Detects specific test runners (e.g., Jest, Vitest) and sets appropriate reporters (e.g., `--reporter json`) for better parsing.

### Failure Handling

- **rmfilter Integration**:
    - If the command fails, uses `rmfilter` to assemble context for fixing the issue.
    - Examines command output for source code filenames and includes them in an `rmfilter` command with `--with-imports`.
    - Supports additional `rmfilter` arguments passed after a double-dash (`--`) in the input command.
    - Allows a triple-slash (`///`) as a separator for `rmfilter` arguments if a double-dash is needed in the test command itself.
- **Failure Selection**:
    - Provides an interactive multiselect prompt (using `@inquirer/prompts`) to choose which failures to fix.
    - Supports CLI flags to specify fixing:
        - Only the first failure.
        - Failures for a specific test file.
        - All failures at once.
- **Automated Fixing**:
    - Includes a CLI flag (e.g., `--auto-fix`) to automatically submit failures to a model for fixing and apply resulting edits.
    - Accepts an optional parameter to specify the model for submission (e.g., `--model <model-name>`).

### Additional Features

- **Exit Code**:
    - Exits with the same exit code as the underlying command.
- **YAML Plan File**:
    - Supports referencing a YAML plan file to pull information about the latest unfinished task for better context on the command's intention.
- **Code Structure**:
    - Implemented as a reusable function that can be called programmatically from other Node.js code.
    - Provides a separate CLI wrapper script that:
        - Uses `commander` for CLI option and argument parsing.
        - Uses `@inquirer/prompts` for interactive prompts (e.g., failure selection).

## Implementation Details

### CLI Usage Examples


    # Run an npm script and analyze output
    rmfix test

    # Run a standalone command
    rmfix jest -- --reporter json

    # Run with rmfilter arguments
    rmfix test -- libs/db/schema

    # Run with double-dash in test command and rmfilter arguments
    rmfix vitest --test-option -- /// libs/db/schema

    # Force output format
    rmfix test --format json

    # Auto-fix with a specific model
    rmfix test --auto-fix --model grok3

    # Fix only the first failure
    rmfix test --fix-first

    # Fix failures for a specific file
    rmfix test --fix-file src/tests/example.test.js


### Function API

The core `rmfix` function will be callable with a configuration object specifying the command, options, and environment. Example:


    const rmfix = require('rmfix');

    await rmfix({
      command: 'test',
      args: ['--reporter', 'json'],
      format: 'json', // Optional: forces output format
      autoFix: true, // Optional: enables auto-fixing
      model: 'grok3', // Optional: specifies model for auto-fixing
      fixMode: 'first', // Optional: 'first', 'file:<path>', or 'all'
      rmfilterArgs: ['libs/db/schema'], // Optional: additional rmfilter args
      planFile: 'plan.yaml', // Optional: path to YAML plan file
    });


### Dependencies

- **Node.js**: For running commands and parsing `package.json`.
- **`commander`**: For CLI option and argument parsing.
- **`@inquirer/prompts`**: For interactive multiselect prompts.
- **`rmfilter`**: For assembling context and fixing issues.
- Lightweight model integration (to be determined) for parsing unstructured output and auto-fixing.

## Future Considerations

- Support for additional structured output formats beyond TAP and JSON.
- Enhanced test runner detection for other frameworks (e.g., Mocha, Cypress).
- Caching of parsed output or context to improve performance for repeated runs.
- Validation of YAML plan file schema to ensure reliable task context.
