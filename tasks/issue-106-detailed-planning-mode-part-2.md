This project is designed to implement the feature: Detailed Planning Mode Part 2

# Add Command

The `add` command create a new plan YAML file with just a title. 

From there, we should add the ability to the `generate` command to process that plan file and update it with planning. That part will work just like the `generate --simple` command does now, except it won't create a new plan; it will use that existing one.

If positional arguments are given they become the title.

Additional options for `add`:
- `edit`: Open the generated plan file in $EDITOR
- `depends-on`: Specify dependencies from command line
- `priority`: set the priority



# Split Command

The split command should take a plan file that is already planned out and use a language model to split it into multiple phases, each with their own plan file that consists of some of the tasks within that original file. Dependencies between the new tasks should be inferred appropriately as well.