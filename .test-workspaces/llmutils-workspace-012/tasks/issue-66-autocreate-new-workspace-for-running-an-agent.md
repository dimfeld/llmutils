This project is designed to implement the feature: Autocreate new workspace for running an agent

Add configuration into the repository configuration file on how to create a new work tree. This should have the option of running a script that will handle the whole thing, or we can create the work tree ourselves and let the configuration just be a set of commands to run after the head.
create a new workspace using the configured script, either create a new worktree or let the script do it

- create a new clone of a repository
- Ability to run a script that automates the new repository cloning if it needs special behavior 
- Repo level config has commands to run to initialize a new clone
- create a new branch in the clone
- allow customizing the location of clones
- store a record of which task this checkout was for, probably in a global config file or database