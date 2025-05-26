Add a 'agent' command to rmplan. The agent command should:

- Run the equivalent of the "next" command to get a prompt. Use the `rmfilter` option in this case. Make a way to
disable the step selection; instead always do just one step.
- Read the rmfilter output and run the equivalent of the 'rmrun' command to run and apply it.
- If the apply succeeds, run the equivalent of the 'done' command with `commit` enabled.
- Repeat until all tasks and steps are done.

For all of these cases, move the code for some commands into a separate file and its own function to make it easier to
call.
