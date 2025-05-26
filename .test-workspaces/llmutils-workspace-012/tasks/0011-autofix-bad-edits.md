When edits fails to apply, we should try to get it fixed by asking the model again..

Steps:

First gather the original prompt:

1. If you have the last prompt sent in, as in agent mode, use that as the first part of the prompt you will send.

If not, then :

- get the rmfilter context arguments that generated the context. This is within the `<rmfilter_command>` tag,
  which may be in the text of the `content` of applyLlmEdits. Read repomix-output.xml and verify that the
  contents of the rmfilter_command tag match
- If they match, use the rmfilter output as the first part of the prompt. Otherwise, run rmfilter again with 
  those arguments and use the new rmfilter output as the first part of the prompt

2. Construct a model request with:

  - User: the last prompt, or rmfilter output
  - Assistant: the full model output
  - User: information about all the edit failures, and instructions on how to fix them.

3. Wait for the response and use it to try to reapply the diffs
4. If diffs still fail, go into interactive mode to resolve the remaining diffs..



