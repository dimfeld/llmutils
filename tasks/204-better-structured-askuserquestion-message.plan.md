---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: better structured AskUserQuestion message
goal: ""
id: 204
uuid: 37c82076-b32c-40b8-a362-1fd7d3c9cbda
status: pending
priority: medium
createdAt: 2026-02-23T09:02:43.189Z
updatedAt: 2026-02-23T09:02:43.190Z
tasks: []
tags: []
---

Currently when we're handling the Ask User Question tool, we have first a select and then if the user selects free text,
then we do a separate input. This works okay for the GUI it would be much better to just have free text be a selection
and then have a place to type below it. So that it's all in one single message. This will require creating a new custom
prompt type, which is a select with free text option. 
