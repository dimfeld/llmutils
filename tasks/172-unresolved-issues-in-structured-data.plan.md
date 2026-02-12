---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: unresolved issues in structured data
goal: Store unresolved review issues as structured data in plan files, display them in the show command, and provide a command to re-check and address them
id: 172
uuid: d896e81c-e543-4ca6-b892-b4288dbbfc7f
status: pending
priority: medium
createdAt: 2026-02-12T08:31:43.834Z
updatedAt: 2026-02-12T08:31:43.835Z
tasks: []
tags: []
---

Right now we add this as markdown but it would be more useful to have them in structured data in the plan.

Should be an array of something like 
{ 
  // task indexes that were being worked on
  tasks: number[]; 
  // the existing issue type with content, file, line, suggestion, etc.
  issues: Issue[] 
}

Where we currently add "Unresolved Review Issues" add an entry in this array instead.

Then we should show these in the `show` command. No additional 
