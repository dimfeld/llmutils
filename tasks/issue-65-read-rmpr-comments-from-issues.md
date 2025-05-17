This project is designed to implement the feature: Read rmpr comments from issues

These give instructions on how to run rmfilter to generate context. Just like the pr-answer command is able to read `rmpr` lines from the PR comments, we should read them from issue descriptions and comments in the `generate` command.

The options parsed from the comments should be added to the rmfilter arguments that the generate comment uses to create the context for the planning prompt.