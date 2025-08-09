---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Support reading issues from Linear
goal: ""
id: 91
status: pending
priority: medium
createdAt: 2025-08-09T00:50:13.309Z
updatedAt: 2025-08-09T00:50:13.310Z
tasks: []
rmfilter:
- src/rmplan
- src/common/github*

docs:
- https://linear.app/developers/sdk
---

Any rmplan command that reads from a Github issue and its comments should be able to read from Linear instead. No need
to add any support here for pull requests since Linear doesn't host those.

The choice of Github or Linear should be configurable in the project config in configSchema.ts. Look for LINEAR_API_KEY
in the environment to get the API key for the Linear SDK.

Use the @linear/sdk NPM package for the SDK.
