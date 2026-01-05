---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: workspace cloning tweaks for local config files
goal: ""
id: 161
uuid: f7d48064-cd2a-43b9-ae9e-8d9cb29054fe
status: pending
priority: medium
simple: true 
createdAt: 2026-01-05T01:47:12.909Z
updatedAt: 2026-01-05T01:47:12.909Z
tasks: []
tags: []
---

We copy some "local" settings files for rmplan when copying a workspace. Make these changes:

- Use symlinks instead of copying local config files 
- Update workspace cloning methods that use work trees to also symlink the local configs in the new workspace 

