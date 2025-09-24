---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Update generate process to retain more of the planning output
goal: ""
id: 124
status: pending
priority: medium
createdAt: 2025-09-24T09:46:07.509Z
updatedAt: 2025-09-24T09:46:07.509Z
tasks: []
---

The generate process does a lot of research into the repository about how things work but a lot of that is lost when it
is distilled into the plan. We should update the claude code generation to have a three-step process:

1. The existing first prompt that does the generate.
2. An optional second prompt which tells Claude to append all of its findings into the plan file under a "## Research" heading
3. The existing second prompt (now the third) which tells it to generate the plan

The optional second prompt will be run for:
- the generate command always
- the prepare command if the plan's `generatedBy` field is `oneshot`

Then after that, we can reread the plan file and process the markdown into tasks like we do now.
