This project is designed to implement the feature: PR Handler: Autodetect PR from the current branch

Get the current branch (supporting git or jj) and also fetch the list of open PRs from GitHub.

Allow answer-pr to omit the PR number and if it is not provided, find the PR matching the branch name and choose that one to handle. 

If a PR number was explicitly provided, warn if the current branch doesn't seem to match the PR being tried.

rmpr: include src/tim src/rmpr src/common/github