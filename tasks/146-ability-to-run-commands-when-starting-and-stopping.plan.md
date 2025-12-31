---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Ability to run commands when starting and stopping agent command
goal: ""
id: 146
uuid: e37079a4-2cc9-4161-a9a6-b75de7a45756
status: pending
priority: medium
createdAt: 2025-11-07T21:16:48.398Z
updatedAt: 2025-11-07T21:16:48.398Z
tasks: []
---

We want to be able to define commands that can be run in the project level configuration file. For each command, we should be able to run it in daemon mode and then kill it at the end, or just run it and wait for it to finish. These commands should be run when doing the run command. We should also be able to define commands that run when the run command exits, and this should include on a SIGINT or similar.

We also need some ability for a command to indicate if one of the shutdown commands should run. For example, if the Docker containers that it would start are already started, then it might want to indicate that we should not run the shutdown command that turns them off. I'm not totally sure yet how this would work though.
