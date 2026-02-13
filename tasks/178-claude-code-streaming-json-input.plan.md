---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: claude code streaming json input
goal: ""
id: 178
uuid: 8970382a-14d8-40e2-9fda-206b952d2591
status: pending
priority: medium
createdAt: 2026-02-13T06:35:03.721Z
updatedAt: 2026-02-13T06:35:03.721Z
tasks: []
tags: []
---

Enable streaming json input for Claude code, consider just switching to the SDK


Not totally sure but I think the input JSON messages just look like regular API messages

```
{
    type: "user" as const,
    message: {
      role: "user" as const,
      content: [
        {
          type: "text",
          text: "Review this architecture diagram"
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: await readFile("diagram.png", "base64")
          }
        }
      ]
    }
  };
```

We also want to integrate support for the AskUserQuestion tool into the Claude Code permissions MCP. This is described at https://platform.claude.com/docs/en/agent-sdk/user-input#handle-clarifying-questions

Although we are not using the SDK, the input and responses are the same. We get the input as described and then we want to get a
response from the user using the prompt mechanisms in src/common/input.ts. To start we can just run one prompt at a time, one for each question. Need to support both
select and checkbox. We should also support a "Free text" option in which the user chooses to type a custom response.
