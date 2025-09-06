---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: review feedback MCP tool
goal: To create the end-to-end functionality for the review feedback tool, from
  MCP server implementation to user interaction and integration into the
  orchestrator's workflow.
id: 115
status: pending
priority: high
dependencies: []
planGeneratedAt: 2025-09-06T21:40:46.542Z
promptsGeneratedAt: 2025-09-06T22:18:16.514Z
createdAt: 2025-09-06T21:37:23.877Z
updatedAt: 2025-09-06T22:18:16.514Z
tasks:
  - title: Extend MCP Server with Review Feedback Tool
    done: false
    description: >
      This task involves adding a new tool named `review_feedback_prompt` to the
      existing permissions MCP server. The tool will accept a single string
      argument containing the reviewer's feedback. Its execution logic will send
      a `review_feedback_request` over the Unix socket to the parent process and
      wait for a `review_feedback_response`, which will contain the user's input
      to be returned as the tool's result. The implementation follows the
      existing patterns established by the `approval_prompt` tool, using the
      same FastMCP server infrastructure and Unix socket communication protocol.
    files:
      - src/rmplan/executors/claude_code/permissions_mcp.ts
    steps:
      - prompt: >
          Create a new Zod schema called `ReviewFeedbackInputSchema` that
          accepts a single string field called `reviewerFeedback` with a
          description indicating it contains the output from the reviewer
          subagent that needs user feedback.
        done: false
      - prompt: >
          Add a new tool to the FastMCP server called `review_feedback_prompt`
          using `server.addTool()`. The tool should use the
          `ReviewFeedbackInputSchema` for parameters and have a description
          indicating it prompts the user for feedback on reviewer output.
        done: false
      - prompt: >
          Implement the tool's execute function to send a
          `review_feedback_request` message to the parent process via the Unix
          socket, following the same pattern as `requestPermissionFromParent`.
          The message should include the `reviewerFeedback` parameter and wait
          for a `review_feedback_response` containing the user's input.
        done: false
      - prompt: >
          Return the user's feedback as a JSON response in the same format as
          the approval tool, with the user's input as the text content. Handle
          communication errors gracefully by returning an appropriate error
          message if the socket communication fails.
        done: false
  - title: Implement User Prompt Handling in the Main Executor
    done: false
    description: >
      This task focuses on the main `claude_code.ts` executor. The
      `createPermissionSocketServer` method will be updated to handle the new
      `review_feedback_request` message type. Upon receiving this request, it
      will display the review feedback to the user and use a multi-line input
      prompt (like `@inquirer/editor`) to capture the user's response before
      sending it back to the MCP server. The implementation follows the existing
      socket message handling patterns but introduces multi-line text input
      capabilities.
    files:
      - src/rmplan/executors/claude_code.ts
    steps:
      - prompt: >
          Import the `editor` function from `@inquirer/prompts` at the top of
          the file to enable multi-line text input for capturing user feedback.
        done: false
      - prompt: >
          In the `createPermissionSocketServer` method's socket data handler,
          add a new condition to handle `review_feedback_request` message type
          alongside the existing `permission_request` handling.
        done: false
      - prompt: >
          Implement the review feedback request handling by extracting the
          `reviewerFeedback` from the message, displaying it to the user with
          appropriate formatting, and prompting them for multi-line input using
          the `editor` function with a message like "Please provide your
          feedback on the reviewer's analysis:".
        done: false
      - prompt: >
          Send the user's response back to the MCP server as a
          `review_feedback_response` message containing the user's input text.
          Handle any errors from the editor prompt gracefully and return an
          empty string if the user cancels or if an error occurs.
        done: false
  - title: Add Configurable Timeout for the Review Feedback Prompt
    done: false
    description: >
      This task adds a configurable timeout to the new user prompt. A new
      option, `reviewFeedbackTimeout`, will be added to the `permissionsMcp`
      configuration schema. This timeout will be implemented in the
      `claude_code.ts` executor for the review feedback prompt. If the timeout
      is reached, the prompt will be cancelled, and an empty string will be
      returned as the user's feedback. The implementation mirrors the existing
      timeout mechanism used for permission prompts.
    files:
      - src/rmplan/executors/schemas.ts
      - src/rmplan/executors/claude_code.ts
    steps:
      - prompt: >
          Add a new optional field `reviewFeedbackTimeout` to the
          `permissionsMcp` object in `claudeCodeOptionsSchema`. The field should
          be a number with a description indicating it's the timeout in
          milliseconds for review feedback prompts.
        done: false
      - prompt: >
          In the `claude_code.ts` file, modify the review feedback request
          handler to implement timeout functionality using `Promise.race`
          between the editor prompt and a timeout promise, similar to the
          existing permission prompt timeout implementation.
        done: false
      - prompt: >
          Use the `reviewFeedbackTimeout` configuration value if available, or
          fall back to the general `timeout` value if `reviewFeedbackTimeout` is
          not specified. If the timeout is reached, cancel the editor prompt
          using an AbortController and return an empty string as the user's
          feedback.
        done: false
      - prompt: >
          Add appropriate logging to indicate when the review feedback prompt
          has timed out, following the same pattern as the permission prompt
          timeout logging.
        done: false
  - title: Update Orchestrator Prompt to Use the New Tool
    done: false
    description: >
      This task involves modifying the orchestrator's system prompt in
      `orchestrator_prompt.ts`. The "Review Phase" of the workflow instructions
      will be updated to explicitly direct the orchestrator to call the
      `mcp__permissions__review_feedback_prompt` tool with the output from the
      reviewer subagent. The modification ensures that after each review phase,
      the user has an opportunity to provide feedback on the reviewer's
      findings.
    files:
      - src/rmplan/executors/claude_code/orchestrator_prompt.ts
    steps:
      - prompt: >
          Locate the review phase instructions in the
          `buildWorkflowInstructions` function and modify them to include a step
          instructing the orchestrator to call the review feedback tool after
          receiving output from the reviewer agent.
        done: false
      - prompt: >
          Add specific instructions that the orchestrator should call
          `mcp__permissions__review_feedback_prompt` with the reviewer's output
          as the `reviewerFeedback` parameter, and wait for the user's response
          before proceeding.
        done: false
      - prompt: >
          Update the review phase description to indicate that the user's
          feedback from this tool should be considered when determining whether
          to proceed to the next phase or return to implementation for
          revisions.
        done: false
  - title: Update Orchestrator Prompt to Prioritize User Feedback
    done: false
    description: >
      This task enhances the orchestrator's instructions to ensure it correctly
      interprets the user's feedback. The prompt will be updated to state that
      the user's response from the feedback tool is the definitive source of
      truth and must take priority over any suggestions from the reviewer agent,
      even if the reviewer has marked an issue as high priority. This ensures
      that the user maintains ultimate control over the development process and
      can override reviewer recommendations when appropriate.
    files:
      - src/rmplan/executors/claude_code/orchestrator_prompt.ts
    steps:
      - prompt: >
          Add a new section in the `buildImportantGuidelines` function
          specifically about user feedback priority, stating that user feedback
          from the review feedback tool always takes precedence over reviewer
          agent suggestions.
        done: false
      - prompt: >
          Include explicit instructions that even if the reviewer agent marks
          something as high priority or critical, the user's feedback can
          override these recommendations, and the orchestrator should respect
          the user's judgment.
        done: false
      - prompt: >
          Add guidance that if the user indicates certain reviewer feedback is
          incorrect or not important, the orchestrator should proceed
          accordingly rather than insisting on addressing reviewer concerns that
          the user has dismissed.
        done: false
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
