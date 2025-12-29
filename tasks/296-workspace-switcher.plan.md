---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: workspace switcher
goal: ""
id: 296
uuid: 4a39959d-e9fb-4fa6-b4ed-774a5b4dfd4d
simple: false
status: pending
priority: medium
container: false
temp: false
dependencies: []
references: {}
issue: []
pullRequest: []
docs: []
createdAt: 2025-12-29T01:17:52.736Z
updatedAt: 2025-12-29T01:17:52.736Z
progressNotes: []
tasks: []
tags: []
---

- Named workspaces with rmplan command to switch via a bash function, add a selector that lets you find based on the issue, branch, issue title, etc.
- Add a command to update a workspace (or the current one) with a name and description.
- When running the `agent` command automatically update the description of the current workspace
- This will need to end with a `cd` command, so the implementation here should be a combination of:
  - workspaces list command should list the directory, name, description, and branch
  - use fzf to allow the user to select a workspace
  - run the `cd` command on the result 
- Then a `shell-integration` command that outputs a bash or zsh function for the above that can be put into a file and sourced


