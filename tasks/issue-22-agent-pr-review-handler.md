Need a way to review a PR and have the agent pull down the review and try to apply fixes

What I’m thinking is 

- Create a new command script called `rmpr`
- use the Github API to fetch the unresolved PR review comments
- Show a checkboxes dialog to choose which ones we want to handle
- Support two modes (described below):
- Once the files have been set up for submission, give the user a chance to edit them.
- Once the user presses enter (or runs with an option to not need this) then go ahead.
- gather appropriate context (including diff from the parent branch), call the model to fix the bugs, and apply the edits.

## Building Context

The context that we pass to the model has three parts. One is the current state of the files and the files that it imports. Next is the diff from the parent branch and finally the comments to be addressed, which are inserted based on which editing mode is selected. 

## Editing Modes

### AI Comments

This mode places AI comments into the source code corresponding to the review comments. For each block of code that has a comment, above the block, we should place the comment contents and a start indicator with a unique identifier that is short but easy for the LLM to pull out. Prefix each line of the comment with "AI:".  And then at the end of the block of code, we place an end comment with the same identifier. When only a single line of code is commented, there's no need for the identifier and the start and end; we can just place the description above the commented line. 

We also need a prompt for editing that instructs the model to find the AI comments and address them. We should tell the model to not add any comments indicating that it addressed the comment just to make the requested change. 

In this mode, add the AI comments into the actual original files. No need to make a shadow version or anything like that, since this makes it easier for the user to edit the comments in a confirmation step. We can then remove the comments in a postprocessing step as needed.

### Separate Context

In this mode, we place the review comments in a separate block after the code, where each one has the comment and the relevant diff and context. The prompt then tells the model to address the comments, looking back at the original file and the diff for more context.