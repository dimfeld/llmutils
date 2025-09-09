interface BuildPromptOptions {
  planId: string;
  planTitle: string;
  planFilePath: string;
  batchMode?: boolean;
}

/**
 * Build a single, self-contained prompt for the Codex CLI that encapsulates
 * the implement → test → review loop and then executes against the provided context.
 *
 * Codex does not support subagents, so we inline the orchestration as explicit steps.
 */
export function buildCodexOrchestrationPrompt(contextContent: string, options: BuildPromptOptions) {
  const batchModeHeader = options.batchMode
    ? `# Batch Task Processing Mode

You may be provided multiple incomplete tasks from a plan. Your responsibilities:
- Analyze all tasks to understand scope and dependencies
- Select a reasonable subset (1–3 tightly related tasks) to complete in this pass
- Execute fully (implementation, tests, review), then repeat until the review is ACCEPTABLE.

Only mark tasks done after they are implemented, tested, and reviewed.
`
    : '';

  const planUpdate = options.batchMode
    ? `
## Plan Updates
After successfully completing selected tasks, update the plan file conservatively:
- Mark each completed task as done by executing the following command: \`rmplan set-task-done ${options.planId} --title "<exact task title>"\`
- Do not mark partially-complete tasks as done.
`
    : '';

  const header = `You are an autonomous senior developer using the Codex CLI.
You will implement features iteratively with an implement → test → review loop until the work meets standards.
Adapt to the repository's language, tools, and conventions.

${batchModeHeader}
`;

  const workflow = `## Workflow

Your development process should follow best practices, and include the following steps:

1) IMPLEMENTATION
   - Read the context and identify the concrete, minimal set of changes required.
   - Modify code incrementally. Prefer small, safe steps.
   - Follow existing patterns and architecture in this repository.
   - Maintain strong type safety and runtime safety where applicable (e.g., TypeScript, Rust, Go, Java, Python with typing).
   - When adding features, also add or update tests alongside the code.

2) TESTING
   - Discover and use the project's toolchain and commands:
     - Check for scripts (e.g., package.json, pyproject.toml, Makefile, Taskfile, Cargo.toml, go.mod, Gradle/Maven build files).
     - Run the project's type checks and linters if present (e.g., tsc/mypy/ruff/eslint/flake8/cargo clippy/golangci-lint, etc.).
     - Run the project's test suite (e.g., npm test/bun test/pnpm test/pytest/nox/tox/cargo test/go test/gradle test/mvn test, etc.).
     - Run formatting if available (e.g., prettier/ruff format/black/clang-format/gofmt/cargo fmt, etc.).
   - Fix failures and iterate until green.

3) REVIEW
   - Critically review the tasks you just completed.
   - Identify bugs, violations of patterns, security issues, or inadequate tests.
   - If issues are found, write a short Review Report (issues + verdict NEEDS_FIXES) and loop back to IMPLEMENTATION to address them.
   - If acceptable, write a short Review Report with verdict ACCEPTABLE and proceed.

${planUpdate}

## Repository Conventions and Commands
- Discover the stack and follow existing standards (language, build system, testing framework, formatter).
- Prefer bottom-up refactors; update utilities first, then callers.
- Keep changes minimal and focused; follow strict typing and error handling if applicable.
- For large or ambiguous tasks, break work into small, verifiable steps.

## Reading Files
- Always read the file in full, do not be lazy
- Before making any code changes, start by finding & reading ALL of it
- Never make changes without reading the entire file

## Deliverable
- Apply changes directly in the working tree.
- Ensure all checks and tests pass.
- Provide a concise Review Report at the end and stop when ACCEPTABLE.

## Context and Task
Plan: ${options.planTitle} (id: ${options.planId})
Plan file: ${options.planFilePath}

---
${contextContent}
---
`;

  return `${header}${workflow}`;
}
