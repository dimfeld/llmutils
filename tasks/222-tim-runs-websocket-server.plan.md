---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: tim runs websocket server
goal: ""
id: 222
uuid: 80e8e677-777a-4917-9d42-984dfca6d8f3
status: pending
priority: medium
parent: 221
references:
  "221": 8d41284b-b510-4713-bd21-2db13687f2e5
createdAt: 2026-03-07T07:46:46.426Z
updatedAt: 2026-03-22T07:28:29.455Z
tasks: []
tags: []
---

As a complement or replacement to current system where it is a client and tries to connect to tim-gui.

We need a way to list active processes locally by looking in a well-known directory where each process has a PID-named
info file which contains JSON information containing:
- session ID (random uuid)
- the port is is listening on (should request 0 by default to get a random port)
- the active directory, workspace, plan ID

And then tim GUI can connect to that and see new sessions by watching the directory.

Add an option to the various long-running commands (agent, review, generate, etc) to allows setting a particular port.
If a port is requested but not available, then exit. This will facilitate running on a remote server or inside a
container where there will be just a single tim instance at a time.

This should have an option to require a bearer token to connect, if an environment variable is set with the token.
