---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Change description command
goal: ""
id: 106
status: pending
priority: medium
createdAt: 2025-08-14T00:55:08.903Z
updatedAt: 2025-08-14T00:55:08.903Z
tasks: []
rmfilter:
    - src/rmplan/commands/review.ts
    - --with-imports
    - --
    - src/rmplan/rmplan.ts
---

This works a lot like the existing review command, but with a different prompt that asks it to generate a PR description for work done on a plan.

Create a new function that contains the relevant context gathering used by the review command which can also be used
here.

The output should include details like:
- What was implemented
- What existing functionality was changed
- What might have been changed to implement this plan, but was not
- A description of how the changes work with each other and how it integrates with the rest of the system
- optional diagrams in Mermaid format if helpful to understand the changes
- Potential future improvements

Unlike the review command, we don't need an incremental mode, issue detection, or a "fix" option since it's just generating text.

When done, we should ask to copy to the clipboard and/or create the PR using the Github CLI. Also have the option to
write to a file.
