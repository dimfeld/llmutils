---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: option to notify when done
goal: ""
id: 164
uuid: 08281202-6508-47da-b589-951b6f5fd3de
status: pending
priority: medium
createdAt: 2026-01-05T06:42:25.241Z
updatedAt: 2026-01-05T06:42:25.241Z
tasks: []
tags: []
---

Config option to run a script that can notify or something whenever exiting an "agent" command or when a "review" command is done or ready for input.

This should work similarly to how Claude Code does its notify scripts, passing JSON on stdin.


Something like this:

interface Notification {
  source: 'rmplan';
  command: 'agent'|'review';
  cwd: string;
  planId: string;
  planFile: string;
  planSummary: string;
  planDescription: string;
  message: string;
}


This should be globally configurable so we may need a new config file inside ~/.config/rmplan/config.yml. This
config should share a lot of values with the per-project config file.
