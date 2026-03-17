---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Sessions view with real-time streaming
goal: ""
id: 229
uuid: fb9383c8-5ee1-4084-afe6-8a8572189d4e
status: pending
priority: medium
dependencies:
  - 228
parent: 227
references:
  "227": 6787e32d-3918-440e-8b8b-0562ba59e095
  "228": 68fe5243-cd4b-46cf-81e1-6f930d29e40b
createdAt: 2026-03-17T09:05:17.148Z
updatedAt: 2026-03-17T09:05:17.157Z
tasks: []
tags: []
---

Implement the WebSocket server on port 8123 using Bun.serve() to receive tim agent connections, HTTP notification endpoint, server-side session manager with replay buffering and message formatting, SSE endpoint for streaming session events to browser, and the full Sessions UI with grouped session list, rich message rendering (text, monospaced, todo, file changes, key-value pairs), prompt rendering (confirm, input, select, checkbox), and user input bar.
