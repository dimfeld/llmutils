This project is designed to implement the feature: New fields for planning YAML
 
- status: planning, ready, in progress, done
- priority: optional, one of unknown, low, medium, high, urgent
 id: a base36 timestamp (with epoch 2025-05-01) assigned to the file when it is created, to allow referencing it from other files. If multiple files are created for a single task, they all share the same timestamp with a dash and a sequential id appended
- dependencies: optional, array of ids of other task files that this depends on
- baseBranch: optional, in case this is building on a previous branch
- changedFiles: optional, an array of files that have been changed/created by this task
- rmfilter: optional, array of rmfilter arguments to run to gather context for detailed planning
- issue: optional, array of URLs to the relevant issues for this task
- pullRequest: optional, array of URLs for pull requests for this task
- planGeneratedAt
- promptsGeneratedAt
- createdAt
- updatedAt

The existing planning prompt and "markdown to yaml" steps should not change to handle any of these fields.

## Keys to initialize after YAML is returned from the model

- id
- createdAt, updatedAt, planGeneratedAt, promptsGeneratedAt - these can all be the same "now" date at first
- priority
- issue - if --issue was used
- rmfilter - if `rmfilter:` comments were in the issue and with the rmfilter arguments passed to `tim generate`
- status: New task files should start in the pending status, move to in progress as soon as a step starts, and then change to done once all steps are done. "Planning" is reserved for future use
 
Every time a step is completed, we should compare the list of changed files to baseBranch (or main/master if not set) and update changed files to be that set of files. 
 
## Keys that can be blank

These keys can be left empty for now and will be used more in future work:
- dependencies
- baseBranch
- pullRequest

## Other notes

Use the existing functionality for parsing rmpr: and rmfilter: comments for parsing the rmfilter: comments here. Same goes for finding changed files. 



rmfilter: src/rmpr src/tim --with-imports
rmfilter: src/rmfilter
