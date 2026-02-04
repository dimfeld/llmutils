In rmfind: Update the rmfind code so that it can be imported and called from other Javascript files, and update the command-line argument parsing code to be a wrapper around that.
Separate the core code and wrapper into two files.

In tim: Add an --autofind option to the tim command. This option should run the rmfind code with the plan file as input, and include
all files returned from it in the rmfilter args.

