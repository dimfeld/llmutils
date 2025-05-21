This project is designed to implement the feature: Support OSC52 copy/paste

To better support running in SSH sessions

- Check the SSH connection or SSH client environment variables to see if we're in an SSH session. 
- Create a wrapper function around the clipboard reading and writing that will use OSC 52 if we are, and the clipboardy package which we're already using if not. 
- Use the wrapper everywhere

rmfilter: . --grep clipboard