Generating yaml directly is not friendly for evaluating the plan and making changes.

Update the generate prompt to make the plan in markdown and then do yaml conversion in the extract step. This makes it easier to edit the plan before it becomes yaml.

Automate the markdown -> yaml conversion step in the extract command by sending a prompt to Gemini Flash 2.0 that converts it to the current YAML schema.
