---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: less annoying messages in interactive mode
goal: ""
id: 199
uuid: 2da8f054-98c9-4fe1-b0ee-d33150931fbc
status: done
priority: medium
createdAt: 2026-02-15T09:54:30.498Z
updatedAt: 2026-02-15T09:59:12.011Z
tasks: []
tags: []
---

Every time an agent turn ends we print:

```
### Done [23:36:05]
Success: yes, Duration: 340s, Cost: $3.75, Turns: 18
```


Every time we resume we print:

```
### Starting [23:30:25]
Executor: claude
```

Let's update both of these to just print the entire message on one line
