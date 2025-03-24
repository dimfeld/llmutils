# llmutils

Command-line utilities for managing context with chat-oriented programming, and applying edits back.

This is unoptimized and a bit of a mess right now, but overall works well for collecting a relevant set of files when
you know a good starting point.

The two scripts are:
- rmfilter: A wrapper around repomix which can analyze import trees to gather all the files referenced by a root file, and add instructions and other rules to the repomix output. Supports both "whole file" and "diff" edit modes.
- apply-llm-edits: Once you've pasted the rmfilter output into a chat model and get the output, you can use this script to apply the edits back to your codebase.
