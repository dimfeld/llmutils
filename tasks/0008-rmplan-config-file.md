tim should be able to read from a YAML configuration file. 

# Finding the configuration file

1. Look for `.rmfilter/tim.yml` in the repository root. It is ok if this file does not exist.
2. Add a `-c, --config` option to the `tim` command to specify a different configuration.

# Configuration File Format

This format should be specific to the repository, not to a specific feature. To start there is just one setting to add:

## post-apply commands

This is a list of commands to run after every apply step. Things like formatting and so on. We should be able to set:
- the title of the command
- the command to run
- the working directory (optional, use repository root by default)
- any environment variables to set (optional)
- a setting to allow failure, which defaults to `false`. If `false`, the agent loop should exit if the command ends with
  a non-zero exit code. If true, the failure should be ignored.
