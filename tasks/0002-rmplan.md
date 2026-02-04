This is a new utility called tim, which is used for generating plans for a given task and then executing that plan.

## Commands

### Generate
 
The `generate` command generates a planning prompt and context for a given task by inserting the plan into the planning prompt at rmfind/prompt.ts,
and then calling rmfilter to generate the context. It should support --plan and --plan-editor arguments, similar to the rmfilter
command's --instruction and --instruction-editor arguments.

Once the planning prompt is created, take all the other arguments after the first `--` in the command line and pass them
to the rmfilter command, along with the `--bare` flag and the relevant `--instructions @tempfile.md` argument to include the planning
prompt. You can save the planning prompt to a temporary file.

### Extract

The `extract` command takes a response from the language model which should contain a YAML file that complies with the
`planSchema`. The response may include other text so it should find the relevant portion to parse. Then output to stdout
or write it to a file if the `-o` argument is provided.

### Done

The `done` command takes a YAML file as an argument that complies with `planSchema`. Find the next unfinished step and mark it as done.
If the --task argument is provided, find the next unfinished step and mark all the steps in that task as done.

### Next

The `next` command takes a YAML file as an argument that complies with `planSchema`. 

1. Find the next unfinished task to work on.
2. Look at all the unfinished steps in that task.
3. Show the unfinished steps, and allow the user to choose up to which step should go into the prompt. 
4. Output the combined prompt with the files, steps and other relevant information from the task and top-level context. Include
   a bit of information about previous steps that were done.
