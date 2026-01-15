---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: remote-controlled terminal
goal: ""
id: 166
uuid: 783bf184-9ec5-4919-bf30-8ae618785f0c
status: pending
priority: medium
parent: 160
createdAt: 2026-01-12T06:36:28.922Z
updatedAt: 2026-01-12T06:36:28.924Z
tasks: []
tags: []
---

We should have some method of exposing all the terminal output over a socket and also allowing terminal input into that socket.

We can do this by having the actual rmplan command be a small wrapper process that uses the node-pty package to create a pseudo terminal and then spawn the actual rmplan command inside that. It's probably worth doing this only for commands that have a lot of interactivity, such as review or agent. That way, the other commands that really should be fast, such as add or list, will not slow down with the spawning.

It actually might be better to use a JSON format for this case and just expose multiple shells so that the actual rmplan process is running as a headless server, and then the default terminal-based process prints everything to the console. We would also need to make sure that interactive prompts, such as through Inquirer, are handled properly. This involves doing the actual prompt in the terminal-based process and having some other method inside the headless process that waits for a response over the socket. 
