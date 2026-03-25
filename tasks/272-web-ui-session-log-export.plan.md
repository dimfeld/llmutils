---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "Web UI: Session log export"
goal: Add the ability to export a session transcript as markdown or plain text,
  with options to copy to clipboard or download as a file, for sharing context
  or debugging.
id: 272
uuid: 19cb5f45-f68b-419f-a281-4d17acfd9067
status: pending
priority: medium
createdAt: 2026-03-24T19:18:04.834Z
updatedAt: 2026-03-24T19:18:04.835Z
tasks: []
tags:
  - web-ui
---

## Overview

Session transcripts are only viewable in the web UI with no way to export or share them. Adding export functionality would help with debugging, sharing context with teammates, and record-keeping.

## Key Features

- **Copy to clipboard**: Button in `SessionDetail` header that copies the full transcript as formatted markdown.
- **Download as file**: Option to download as `.md` or `.txt` file with session metadata header (plan, workspace, timestamps).
- **Selective export**: Ability to select a range of messages to export rather than the full transcript.
- **Format options**: Markdown (with code blocks preserved) and plain text (stripped formatting).

## Implementation Notes

- Message formatting logic already exists in `SessionMessage.svelte` — extract a `formatMessageAsText()` utility
- Use the Clipboard API for copy and create a Blob download for file export
- Add export buttons to the `SessionDetail` header bar
- Include session metadata (plan number, workspace, start/end time) in the export header
- Consider filtering out internal/system messages from the export
