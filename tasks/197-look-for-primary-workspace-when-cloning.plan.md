---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: look for primary workspace when cloning
goal: ""
id: 197
uuid: 53a61dd1-64ef-4999-a96f-04a51ec30e14
status: pending
priority: medium
createdAt: 2026-02-15T08:38:59.485Z
updatedAt: 2026-02-15T08:38:59.486Z
tasks: []
tags: []
---

Don't require a sourceDirectory when cloning a new workspace if there is a "primary" workspace for the repository. Instead fallback to the directory of the primary workspace.
