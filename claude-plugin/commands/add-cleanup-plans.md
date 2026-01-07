---
description: Add cleanup plans
allowed-tools: Bash(rmplan add:*)
---

Examine the repository for cleanup tasks such as:

**Code Quality**

- Duplicated code that could be consolidated into shared utilities
- Dead code: unused functions, variables, imports, or entire files
- Inconsistent patterns: different approaches to the same problem across the codebase
- Magic numbers/strings that should be named constants
- Overly complex functions that could be simplified or split

**Technical Debt**

- TODO/FIXME comments that should be addressed
- Deprecated APIs or patterns still in use
- Workarounds that are no longer necessary
- Legacy code that doesn't follow current project conventions

**Type Safety & Error Handling**

- Bypassing type safety when the code could be properly typed
- Missing or inconsistent error handling
- Unsafe type assertions that could be replaced with type guards

**Architecture & Organization**

- Poor module boundaries or circular dependencies
- Files in incorrect locations based on project structure
- Tightly coupled code that should be decoupled
- Missing abstractions that would simplify multiple call sites

**Dependencies**

- Unused dependencies
- Duplicate packages serving the same purpose

**Testing**

- Important code paths lacking test coverage
- Flaky or poorly written tests
- Test utilities or setup code that could be shared

For each cleanup task you identify, add it as a plan using `rmplan add`. Include relevant details and options:

```
rmplan add "<task title>" --details "<description of what needs to be done>" [options]
```

Key options:

- `--details "<text>"` - Markdown description of the task
- `--priority <level>` - low, medium, high, or urgent
- `--tag <tags...>` - Add tags like "refactor", "testing", "cleanup"
- `--rmfilter <files...>` - Specify relevant files to include as context
- `--simple` - Mark simple tasks that don't need much research to be done properly

Example:

```
rmplan add "Refactor duplicate validation logic" --details "The validateUser and validateAdmin functions in src/auth/ share nearly identical code. Extract common validation into a shared helper." --tag refactor --priority medium --rmfilter src/auth/validate.ts
```

You can also directly edit the plan file after creation to add additional details if you have a lot to add.

Focus on changes that provide meaningful improvements. Prioritize issues that:

1. Affect multiple parts of the codebase
2. Could cause bugs or maintenance burden
3. Make the code harder to understand

Skip trivial issues or combine them into other plans.

After adding the plans, summarize what you added.
