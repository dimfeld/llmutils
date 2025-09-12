---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: better codex agent loop
goal: ""
id: 118
status: pending
priority: medium
createdAt: 2025-09-12T18:50:35.986Z
updatedAt: 2025-09-12T18:50:35.986Z
tasks: []
rmfilter:
  - src/rmplan/executors
  - --with-imports
---

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


