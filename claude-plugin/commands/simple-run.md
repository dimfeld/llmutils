---
description: Just run a tim plan directly in Claude
argument-hint: '[--next-ready] <plan id> | --latest'
allowed-tools: Bash(tim show:*),Bash(tim set:*)
---

This is a tim plan that you should work on now:

!`tim show --full $ARGUMENTS`

When the plan is done, run `tim set -s done <planId>` (before committing) to update the plan's status.

Setting to in_progress now: !`tim set -s in_progress $ARGUMENTS`

If anything is unclear or the plan is complex enough, you may enter plan mode to research and/or ask for clarification
from the user. Otherwise start right away.
