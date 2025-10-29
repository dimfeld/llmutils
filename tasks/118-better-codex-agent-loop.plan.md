---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: better codex agent loop
goal: To create a robust, multi-step agent loop for the Codex executor,
  mirroring the implement-test-review-fix workflow of the Claude Code executor,
  orchestrated manually through sequential calls to the Codex CLI.
id: 118
uuid: a26da1fe-26a0-48db-9de2-d0b1591b260b
status: done
priority: medium
container: false
dependencies: []
issue: []
pullRequest: []
docs: []
planGeneratedAt: 2025-09-12T19:31:52.587Z
promptsGeneratedAt: 2025-09-12T19:39:12.582Z
createdAt: 2025-09-12T18:50:35.986Z
updatedAt: 2025-10-27T08:39:04.214Z
tasks:
  - title: Create a Codex JSON Output Parser
    done: true
    description: >
      Develop a utility function to parse the line-delimited JSON output
      streamed from the `codex exec --json` command. This parser should identify
      different message types (task_started, agent_reasoning,
      exec_command_begin/end, etc.), format them for logging, and critically,
      extract the content of the final `agent_message` which represents the
      output of a given step. The parser should be similar to
      `claude_code/format.ts` but adapted for Codex's JSON format, including
      proper truncation of long outputs and extraction of the final agent
      response.
  - title: Implement a Reusable Single-Step Codex Runner
    done: true
    description: >
      Create a helper function within the `CodexCliExecutor` that takes a prompt
      as input, executes `codex exec --json` using `spawnAndLogOutput`, and
      utilizes the new JSON parser in the `formatStdout` callback. The function
      should stream formatted logs to the console and return the final,
      extracted `agent_message` as a string. This provides the core building
      block for all subsequent multi-step operations.
  - title: Refactor CodexCliExecutor to Execute a Single Implementer Step
    done: true
    description: >
      Update the main `execute` method of the `CodexCliExecutor` to use the new
      single-step runner. It will reuse the `getImplementerPrompt` from the
      Claude Code executor to build a prompt, execute it using the new
      `executeCodexStep` method, and log the final captured output. This
      replaces the old single-prompt logic and validates the new execution
      foundation before proceeding to multi-step orchestration.
  - title: Integrate Plan File Analysis
    done: true
    description: >
      Add logic at the beginning of the `execute` method to read the plan file
      using `readPlanFile` from `plans.ts` and identify which tasks are already
      completed versus those that are pending. This information is crucial for
      providing correct context to the tester and reviewer prompts, allowing
      them to focus on newly completed work and understand what remains to be
      done.
  - title: Orchestrate the Implementer-to-Tester Flow
    done: true
    description: >
      Extend the `execute` method to chain the first two steps of the agent
      loop. After the implementer step completes, its output will be captured
      and used to construct the prompt for the tester using `getTesterPrompt`,
      along with the list of newly completed tasks. The tester step will then be
      executed using the same single-step runner infrastructure.
  - title: Orchestrate the Tester-to-Reviewer Flow
    done: true
    description: >
      Further extend the `execute` method to add the review step. The output
      from the tester will be captured and used to construct the prompt for the
      reviewer using `getReviewerPrompt`. The reviewer step will then be
      executed, completing the initial implement-test-review cycle before any
      fix loop logic is added.
  - title: Parse and Handle the Reviewer's Verdict
    done: true
    description: >
      Implement logic to parse the final output from the reviewer to find the
      `VERDICT:` line and determine if it is `ACCEPTABLE` or `NEEDS_FIXES`. The
      executor will log the verdict and terminate gracefully, preparing for the
      implementation of the fix loop in the next phase. This completes the basic
      agent loop without fix logic.
  - title: Create the Review Analysis Prompt and Logic
    done: true
    description: >
      Develop a function that constructs a prompt for the `gemini-flash-2.5`
      model to analyze the reviewer's feedback intelligently. This prompt will
      include the reviewer's output, completed tasks, pending tasks, and the
      original implementer output. The function will use `ai.generateObject`
      with a Zod schema to get a structured response indicating if fixes are
      needed and providing specific instructions, helping to avoid unnecessary
      work on issues that are out of scope for the current batch.
  - title: Integrate Review Analysis into the Agent Loop
    done: true
    description: >
      Modify the `CodexCliExecutor` to call the review analysis function when
      the reviewer's verdict is `NEEDS_FIXES`. The result of this analysis will
      determine whether to enter the fix loop or to exit gracefully if the
      flagged issues are deemed not actionable within the current scope of work.
      This prevents the executor from attempting unnecessary fixes based on
      out-of-scope reviewer feedback.
  - title: Implement the Fixer Step
    done: true
    description: >
      Create a new prompt for the fixer step that includes the original
      implementation and testing outputs, the list of completed tasks, and the
      specific `fix_instructions` generated by the review analysis step. This
      prompt will then be executed by the single-step Codex runner to attempt to
      address the issues identified by the reviewer and validated by the
      analysis.
  - title: Implement the Full Fix-and-Review Loop
    done: true
    description: >
      After the fixer step runs, re-execute the reviewer on the updated code.
      Wrap this entire fix-and-review cycle in a loop that terminates when the
      reviewer's verdict is `ACCEPTABLE` or after a maximum of 5 iterations.
      This completes the full agent loop with intelligent fixing capabilities,
      ensuring that the code meets quality standards before the executor
      finishes.
changedFiles:
  - src/rmplan/commands/add.test.ts
  - src/rmplan/commands/cli_integration.test.ts
  - src/rmplan/executors/codex_cli/format.test.ts
  - src/rmplan/executors/codex_cli/format.ts
  - src/rmplan/executors/codex_cli/review_analysis.test.ts
  - src/rmplan/executors/codex_cli/review_analysis.ts
  - src/rmplan/executors/codex_cli.fix_loop.test.ts
  - src/rmplan/executors/codex_cli.ts
rmfilter:
  - src/rmplan/executors
  - --with-imports
---

# Original Plan Details

We want to set up a real agent loop with the codex agent, similar to what we are doing with Claude Code right now. The main difference is that Codex does not support sub-agents, so we need to do this manually. 



## Output parsing

We can execute Codex with the `--json` flag to get the output in JSON format. This will allow us to parse the final
message and extract the answer.

Each JSON message is on a single line, so we should also reuse some of the code from the claude code executor around parsing streaming JSON.

### Initial Message

{"model":"gpt-5","reasoning summaries":"auto","provider":"openai","sandbox":"read-only","workdir":"/code","approval":"never","reasoning effort":"medium"}

### Task Started

{"id":"0","msg":{"type":"task_started","model_context_window":272000}}

### Agent Message

{"id":"0","msg":{"type":"agent_reasoning","text": "" } }

### Agent Reasoning

{"id":"0","msg":{"type":"agent_reasoning","text": "" } }

### Starting a command 

{"id":"0","msg":{"type":"exec_command_begin","call_id":"call_nxhTvx9RAZI2qws7Z3sNDC4L","command":["bash","-lc","sed -n '1,200p' src/rmpr/main.ts"],"cwd":"/code","parsed_cmd":[{"type":"read","cmd":"sed -n '1,200p' src/rmpr/main.ts","name":"main.ts"}]}}

### Command Streamed Output

This can be ignored right now

{"id":"0","msg":{"type":"exec_command_output_delta","call_id":"call_pYTCaUNBxnWcv9cAmQBzCGX6","stream":"stdout","chunk":"base64 encoded output" } }

### Finishing a command

{"id":"0","msg":{"type":"exec_command_end","call_id":"call_nxhTvx9RAZI2qws7Z3sNDC4L","stdout": "", stderr: "",
 "exit_code":0,"duration":{"secs":0,"nanos":0},"formatted_output": "", "aggregated_output": ""
} }

We should truncate the output to 20 lines before printing it.

### Token count update

{"id":"0","msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":314781,"cached_input_tokens":231424,"output_tokens":2317,"reasoning_output_tokens":1664,"total_tokens":317098},"last_token_usage":{"input_tokens":28596,"cached_input_tokens":27520,"output_tokens":741,"reasoning_output_tokens":704,"total_tokens":29337},"model_context_window":272000}}}

### Other messages

We can ignore these message types:
- agent_reasoning_section_break

## Agent Loop

We should reuse the implementer, tester, and reviewer prompts that exist for the Claude Code executor. At each step that
involves running Codex, get the final "agent_message" as the output of the step.

### Initial Steps

1. Look at the plan file and see which tasks are done or not.
2. Run the implementer
3. Look at which tasks in the plan file are now done which were not before
4. Run the tester, passing it the tester prompt, the final implementer output, and the tasks that are now marked as "done"
5. Run the reviewer, passing it the reviewer prompt, the final tester output, and the tasks that are now marked as "done"
6. If the reviewer says thing are ACCEPTABLE, then we are done. If the reviewer says NEEDS_FIXES then we enter the fix
   stage


### Fix Stage

### Review Analysis

Sometimes reviewers will flag things that are not actual problems. For example, complaining about missing code that is
only missing because it is scheduled in a future task. So we want to use some intelligence to
analyze the review output in the context of what is expected.

Create a prompt that has the following:

1. The reviewer output
2. The repository-specific review document, if present
3. The tasks that are now done
4. The tasks that are now not done (and so not expected to be done yet)
5. The implementer output
6. Instructions to decide if fixes are actually needed, and if so, instructions extracted from the reviewer output on what to fix.

Pass this prompt to the gemini-flash-2.5 model using the ai.generateObject call with the schema:
z.object({ needs_fixes: z.boolean()); fix_instructions: z.string().optional() })

### Fix Stage Loop

1. Run the review analysis
2. If review analysis says that fixes are needed, run codex with a prompt including: the implementer and tester output, the tasks that are now done, and the fix_instructions
3. Run the reviewer again, passing in the final output from step 1
3. If the reviewer says thing are ACCEPTABLE, then we are done. If the reviewer says NEEDS_FIXES then we enter the fix loop again,

The fix loop should end when the reviewer says ACCEPTABLE or after 5 rounds of fixes.

# Processed Plan Details

## Implement a Multi-Step Agent Loop for the Codex CLI Executor

This project will replace the current single-prompt `CodexCliExecutor` with a sophisticated, multi-step agent loop. Since Codex does not support sub-agents, this loop will be orchestrated within the executor by making sequential calls to the `codex exec` command. The project involves three main stages: parsing the streaming JSON output from Codex, implementing the primary implement-test-review workflow, and finally, adding an intelligent fix loop that uses an LLM to analyze review feedback before attempting corrections.

### Acceptance Criteria
- The `CodexCliExecutor` successfully runs an implement -> test -> review -> fix loop.
- The executor correctly parses streaming JSON output from the `codex exec --json` command to extract the final agent message at each step.
- The existing implementer, tester, and reviewer prompts from the Claude Code executor are reused.
- A "Review Analysis" step is implemented, using the `gemini-flash-2.5` model to intelligently decide if reviewer-flagged issues require fixes.
- A fix loop attempts to correct issues identified by the reviewer and validated by the analysis step, running for a maximum of 5 iterations.
- The entire process is logged clearly to the console, showing the progression through each stage of the loop.

### Technical Considerations
- The core logic will reside in `src/rmplan/executors/codex_cli.ts`.
- A new module will be created for parsing and formatting the Codex-specific JSON output, similar to `src/rmplan/executors/claude_code/format.ts`.
- The `spawnAndLogOutput` utility will be used to execute `codex exec --json`, with a custom `formatStdout` callback to handle the streaming JSON.
- The `ai.generateObject` function from the Vercel AI SDK will be used for the Review Analysis step.
- State (e.g., outputs from previous steps, fix loop count) must be managed within the `execute` method of the `CodexCliExecutor`.

---

## Area 1: Core Execution and Output Parsing

Tasks:
- Create a Codex JSON Output Parser
- Implement a Reusable Single-Step Codex Runner
- Refactor CodexCliExecutor to Execute a Single Implementer Step

This phase focuses on the essential mechanics of interacting with the Codex CLI. We will create a robust JSON stream parser tailored to the Codex output format and a reusable runner function that can execute a given prompt and return the agent's final response. This provides the core building block for the multi-step loop in subsequent phases.

---

## Area 2: Implement the Main Implement-Test-Review Agent Loop

Tasks:
- Integrate Plan File Analysis
- Orchestrate the Implementer-to-Tester Flow
- Orchestrate the Tester-to-Reviewer Flow
- Parse and Handle the Reviewer's Verdict

Building upon the single-step execution capability from Phase 1, this phase will construct the main agent loop. The executor will manage the flow of data between steps, creating the appropriate prompts at each stage. The phase concludes when the first review is complete, and its verdict is successfully parsed and logged.

---

## Area 3: Implement the Intelligent Fix Loop

Tasks:
- Create the Review Analysis Prompt and Logic
- Integrate Review Analysis into the Agent Loop
- Implement the Fixer Step
- Implement the Full Fix-and-Review Loop

This phase introduces the intelligent fix-and-review cycle. When a review verdict is `NEEDS_FIXES`, we will first invoke a separate LLM call to analyze the feedback in the context of the overall plan. This prevents unnecessary work on issues that are out of scope. If fixes are deemed necessary, a new "fixer" prompt is generated and the loop continues until the code is acceptable or a maximum number of iterations is reached.
