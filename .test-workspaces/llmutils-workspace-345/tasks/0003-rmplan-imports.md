Goal: Add options to rmplan which work like the --with-imports and --with-all-imports options for rmfilter.

When running rmplan with these options, the list of candidate files for import analysis should be the filenames in the prompt itself.
Use the `extractFileReferencesFromInstructions` function to find these files. If no files are found, then use the task's
list of files instead.

If running with the --rmfilter option, then these files can be passed in a command block to rmfilter with the relevant
imports option.

If not running with the --rmfilter option, then run the same import analysis that rmfilter does, and add the resulting
list of files to the task `files` list before generating the output. Make sure to dedupe the files list in that case.



