This project is designed to implement the feature: Pluggable logging system

When we move to a chatbot we'll want the option for logs to be console, Discord messages, etc. 

- Create an adapter interface for sending messages. It should follow the same interface exposed by logging,.ts functions log, error, warn, writeStdout, writeStderr, debugLog
- Add functions that use an AsyncLocalStorage to store the adapter for later retrieval
- The first adapter should be for the terminal, and just do what the existing functions in logging.ts do. Put this adapter in src/logging/console.ts. 
- Then change those existing functions in logging.ts to get the adapter and call the appropriate function.
- If no adapter is installed, use the terminal adapter functions

rmfilter: src/logging.ts