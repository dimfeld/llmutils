---
description: Add cleanup plans
allowed-tools: Bash(rmplan add:*)
---

Examine the repository for cleanup tasks such as:

- Improving test coverage for under-tested code
- Refactoring duplicate or similar code
- Removing dead code or unused dependencies
- Improving error handling
- Fixing inconsistent patterns or naming
- Addressing TODO comments that should be resolved
- Improving type safety
- Other code quality improvements

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

Focus on substantive improvements that would meaningfully improve code quality, maintainability, or reliability. Skip trivial issues or combine them into other plans.

After adding tasks, summarize what you added.
