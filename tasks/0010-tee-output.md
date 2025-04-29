The agent should write everything it outputs to another file by default. Just use the same path as the plan YAML file but with `-agent-output.md` at the end instead of `.yml`.

Include an option `--no-save-output` to disable it.

This might be a little tricky because right now we're console logging from all over the place. But if we can just hook into standard out and standard error that would work. Grok recommends just overwriting `process.stdout.write` using code like this:

```js
// Create a FileSink for incremental writing
const logFile = Bun.file(destination);
const logSink = logFile.writer();

// Store original stdout.write method
const originalStdoutWrite = process.stdout.write;

// Override stdout.write
process.stdout.write = function (chunk, encoding, callback) {
  // Capture the chunk (convert to string if it's a Buffer)
  const chunkStr = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;

  // Write to file incrementally using FileSink
  logSink.write(chunkStr);

  // Call the original stdout.write to preserve normal output behavior
  return originalStdoutWrite.apply(process.stdout, [chunk, encoding, callback]);
};


// Ensure log stream is closed properly on process exit
process.on('beforeExit', () => {
  logSink.end();
});
```

If this works we should also redirect stderr to the same file as part of this.
