---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: review feedback MCP tool
goal: To create the end-to-end functionality for the review feedback tool, from
  MCP server implementation to user interaction and integration into the
  orchestrator's workflow.
id: 115
uuid: 891f7b66-b8bc-4ab6-971d-5d88b0c76bdb
status: done
priority: high
dependencies: []
planGeneratedAt: 2025-09-06T21:40:46.542Z
promptsGeneratedAt: 2025-09-06T22:18:16.514Z
createdAt: 2025-09-06T21:37:23.877Z
updatedAt: 2025-10-27T08:39:04.243Z
tasks:
  - title: Extend MCP Server with Review Feedback Tool
    done: true
    description: >
      This task involves adding a new tool named `review_feedback_prompt` to the
      existing permissions MCP server. The tool will accept a single string
      argument containing the reviewer's feedback. Its execution logic will send
      a `review_feedback_request` over the Unix socket to the parent process and
      wait for a `review_feedback_response`, which will contain the user's input
      to be returned as the tool's result. The implementation follows the
      existing patterns established by the `approval_prompt` tool, using the
      same FastMCP server infrastructure and Unix socket communication protocol.
  - title: Implement User Prompt Handling in the Main Executor
    done: true
    description: >
      This task focuses on the main `claude_code.ts` executor. The
      `createPermissionSocketServer` method will be updated to handle the new
      `review_feedback_request` message type. Upon receiving this request, it
      will display the review feedback to the user and use a multi-line input
      prompt (like `@inquirer/editor`) to capture the user's response before
      sending it back to the MCP server. The implementation follows the existing
      socket message handling patterns but introduces multi-line text input
      capabilities.
  - title: Add Configurable Timeout for the Review Feedback Prompt
    done: true
    description: >
      This task adds a configurable timeout to the new user prompt. A new
      option, `reviewFeedbackTimeout`, will be added to the `permissionsMcp`
      configuration schema. This timeout will be implemented in the
      `claude_code.ts` executor for the review feedback prompt. If the timeout
      is reached, the prompt will be cancelled, and an empty string will be
      returned as the user's feedback. The implementation mirrors the existing
      timeout mechanism used for permission prompts.
  - title: Update Orchestrator Prompt to Use the New Tool
    done: true
    description: >
      This task involves modifying the orchestrator's system prompt in
      `orchestrator_prompt.ts`. The "Review Phase" of the workflow instructions
      will be updated to explicitly direct the orchestrator to call the
      `mcp__permissions__review_feedback_prompt` tool with the output from the
      reviewer subagent. The modification ensures that after each review phase,
      the user has an opportunity to provide feedback on the reviewer's
      findings.
  - title: Update Orchestrator Prompt to Prioritize User Feedback
    done: true
    description: >
      This task enhances the orchestrator's instructions to ensure it correctly
      interprets the user's feedback. The prompt will be updated to state that
      the user's response from the feedback tool is the definitive source of
      truth and must take priority over any suggestions from the reviewer agent,
      even if the reviewer has marked an issue as high priority. This ensures
      that the user maintains ultimate control over the development process and
      can override reviewer recommendations when appropriate.
rmfilter:
  - src/rmplan/executors/claude_code.ts
  - src/rmplan/executors/claude_code
  - --with-imports
---

# Original Plan Details

Add an MCP tool to the claude code executor for review feedback. 

This tool should also live inside the permissions MCP server, and its tool should just take a string of the review feedback, and return a string of what the user types in response.

When the tool is called, communicate that over the Unix socket and let the user type something in response. The user should be able to add multi-line text easily. Once done, send the text back as an MCP tool response.

Allow the timeout here to be configurable, just like it is with the permissions tool.

Finally, update the orchestrator prompt to tell it to call this MCP tool every time it gets output from the reviewer
subagent, and consider what the user said about the review. For example, some issues found by the reviewer may be
incorrectly flagged and/or not actually important. The user's feedback should always take priority over the reviewer
feedback, regardless of the priority that the reviewer assigned to the issue.

# Processed Plan Details

This project will add a new tool to the Claude Code executor's MCP (Multi-Capability Peripheral) server. The tool will be used to capture user feedback on the output generated by the code reviewer subagent.

Analysis of Work: The implementation will follow the pattern of the existing permissions prompt. A new tool will be added to the `permissions_mcp.ts` server. When this tool is invoked by the orchestrator agent, it will send a request over a Unix socket to the main `claude_code.ts` process. This process will then display the reviewer's feedback to the user and prompt them for multi-line text input. The user's response will be sent back to the MCP server and returned as the tool's output. The timeout for this prompt will be configurable. Finally, the orchestrator's main prompt will be updated to instruct it to use this new tool after every code review and to treat the user's feedback as the ultimate source of truth, overriding the reviewer's suggestions.

Acceptance Criteria:
- A new tool, `mcp__permissions__review_feedback_prompt`, is available to the orchestrator agent.
- When the orchestrator calls this tool with the reviewer's feedback, the user is prompted in the terminal to provide their own feedback.
- The user can easily enter multi-line text in the terminal.
- The text entered by the user is returned as the result of the tool call.
- The prompt has a configurable timeout. If the timeout is reached, an empty string is returned.
- The orchestrator's system prompt instructs it to use this tool after every review and to prioritize the user's feedback above the reviewer's, regardless of the priority assigned by the reviewer.

Technical Considerations:
- The new tool will be added to the existing `FastMCP` server in `permissions_mcp.ts`.
- A new request/response message type (e.g., `review_feedback_request`/`review_feedback_response`) will be defined for the Unix socket communication.
- The `@inquirer/editor` prompt is a suitable choice for capturing multi-line user input in the terminal.
- The timeout mechanism will be implemented using `Promise.race`, mirroring the existing implementation for the permissions prompt.

This phase covers the complete implementation of the review feedback feature. We will start by creating the new tool in the MCP server and the corresponding communication logic. Then, we will implement the user-facing prompt in the main executor process, including the configurable timeout. Finally, we will update the orchestrator's instructions to ensure it utilizes the new tool correctly and understands how to prioritize the user's feedback.
