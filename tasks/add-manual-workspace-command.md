We need a way to manually add a workspace. Right now this is only done as part of the `tim run` command but there
should be an explicit command that just adds and initializes a workspace.

It should be optional to specify a plan ID or file for the workspace. If specified, we should:
- Mark the plan in_progress in the current workspace.
- Create a new workspace for the plan.
- Mark the plan in progress in the new workspace.
