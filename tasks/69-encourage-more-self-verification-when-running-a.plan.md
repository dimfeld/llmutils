---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Encourage more planning and self-verification when running a task
goal: ""
id: 69
status: pending
priority: medium
createdAt: 2025-07-20T00:16:47.678Z
updatedAt: 2025-07-20T00:16:47.678Z
tasks: []
rmfilter:
- src/rmplan/commands/agent.ts
- --with-imports
---

We want to make sure that the agent does not just generate code and not check it. So we want to add a second step where
the agent should:
- Verify that the changes it just made match the plan and the best practices in the codebase.

Update the buildExecutionPrompt function in src/rmplan/prompt_builder.ts to add extra directions that
- Verify that the steps match the best practices and existing patterns of the codebase.
- Generate a TODO list to track its progress.
- Ensure that its changes build and pass lints and tests.

You can take some inspiration from the following example:


## The "Explore, Plan, Code, Test" workflow 

This workflow isn't a perfect fit for what we are doing, but it is a good starting point. The main difference in our
usage is that when we are running we already have a plan, and so any exploration or planning steps should instead
examine how the plan fits into the current codebase and any previous phases or tasks.

When running a stub plan that doesn't have a lot of details filled in, then we want to include more of the Explore and
Plan phases though.

### Explore
First, use parallel subagents to find and read all files that may be useful for implementing the ticket, either as examples or as edit targets. The subagents should return relevant file paths, and any other info that may be useful.

### Plan
Next, think hard and write up a detailed implementation plan. Don't forget to include tests, lookbook components, and documentation. Use your judgement as to what is necessary, given the standards of this repo.

If there are things you are not sure about, use parallel subagents to do some web research. They should only return useful information, no noise.

If there are things you still do not understand or questions you have for the user, pause here to ask them before continuing.

### Code
When you have a thorough implementation plan, you are ready to start writing code. Follow the style of the existing codebase (e.g. we prefer clearly named variables and methods to extensive comments). Make sure to run our autoformatting script when you're done, and fix linter warnings that seem reasonable to you.

### Test
Use parallel subagents to run tests, and make sure they all pass.

If your changes touch the UX in a major way, use the browser to make sure that everything works correctly. Make a list of what to test for, and use a subagent for this step.

If your testing shows problems, go back to the planning stage and think ultrahard.

### Write up your work
When you are happy with your work, write up a short report that could be used as the PR description. Include what you set out to do, the choices you made with their brief justification, and any commands you ran in the process that may be useful for future developers to know about.
