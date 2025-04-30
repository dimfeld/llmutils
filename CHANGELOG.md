# April 30, 2025

- Show reasoning output when running code prompts for models that make it available
- `rmplan generate` command waits for user to copy Markdown response and then runs extract
- Skip writing new files that contain a space in the path. These often indicate comments from the model. (A better heuristic may be useful here.)
- Add `hideOutputOnSuccess` option to `postApplyCommands` to only show the output on failure

# April 29, 2025

- Add comment cleaning command `rmplan cleanup`
- Add model presets for grok and gemini in rmfilter (gemini is same as the default right now)
- Add table of contents to readme
- Write `rmplan agent` output to a log file in addition to terminal
- Some fixes to diff-fenced apply

# April 28, 2025

- Make --changed-files a command-level argument so you can do `--changed-files --with-imports`
- `rmfilter --list-presets` shows if the preset was found in the global directory or the repository
- mdc handling matches Cursor better
- Add note to YAML generation prompt to try to avoid unquoted strings with colons
- Ignore parenthetical comments at end of `files` entries
- Add rmplan agent project configuration file that can run commands after each agent step
- Use temperature 0 when converting markdown to yaml

# April 27, 2025

- rmfilter reads Cursor .mdc files
- Start prompt plan in Markdown and convert to YAML later, to make it easier to review
- Improve udiff matching to handle cases where some context lines are marked as additions

# April 26, 2025

- Add "overeager" prompt line from Aider
- Add `rmplan agent` to automatically execute steps in a plan

# April 25, 2025

- Enforce that all edit applications are inside the repository
- Add options to include file imports in `rmplan next`

