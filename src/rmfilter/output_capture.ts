import { debugLog } from '../logging.js';
import type { FileSink } from 'bun';

/**
 * Starts capturing `process.stdout` and `process.stderr` output, writing it incrementally
 * to the specified file path while also preserving the original console output.
 *
 * @param outputPath The absolute path to the file where output should be saved.
 * @returns A promise that resolves to an object containing a `cleanup` function
 *          if capture starts successfully, or `null` if an error occurs during setup.
 *          The `cleanup` function should be called to stop capturing and close the file.
 */
export async function startOutputCapture(
  outputPath: string
): Promise<{ cleanup: () => void } | null> {
  debugLog(`Attempting to start output capture to: ${outputPath}`);

  let logFile;
  let logSink: FileSink | null = null; // Initialize as null
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  let cleanupCalled = false; // Flag to prevent double cleanup

  // Define the listener function beforehand so we can remove it later
  const beforeExitListener = () => {
    if (!cleanupCalled && logSink) {
      debugLog(`Output capture: beforeExit triggered, ensuring sink is closed for ${outputPath}.`);
      try {
        logSink.end(); // Ensure file is flushed and closed on exit
      } catch (err) {
        // Log directly using original stderr in case of issues during exit cleanup
        originalStderrWrite.call(
          process.stderr,
          `[ERROR] Error closing output capture sink during beforeExit for ${outputPath}: ${err}\n`
        );
      }
    }
  };

  try {
    logFile = Bun.file(outputPath);
    logSink = logFile.writer();
    // Bun's writer seems ready immediately, no explicit await needed unless issues arise.

    // Overwrite stdout.write
    process.stdout.write = (...args: any[]): boolean => {
      const chunk = args[0];
      const encoding = typeof args[1] === 'string' ? args[1] : undefined;

      try {
        const chunkStr = Buffer.isBuffer(chunk) ? chunk.toString(encoding) : chunk;
        if (typeof chunkStr === 'string' && logSink) {
          logSink.write(chunkStr);
          // logSink.flush(); // Consider flushing more frequently if needed, but impacts performance
        }
      } catch (err) {
        // Log write errors to the *original* stderr to avoid loops
        originalStderrWrite.call(
          process.stderr,
          `[ERROR] Failed to write stdout to output capture file ${outputPath}: ${err}\n`
        );
      }

      // Call the original method, preserving its return value and behavior
      return originalStdoutWrite.apply(process.stdout, args as any);
    };

    // Overwrite stderr.write
    process.stderr.write = (...args: any[]): boolean => {
      const chunk = args[0];
      const encoding = typeof args[1] === 'string' ? args[1] : undefined;

      try {
        const chunkStr = Buffer.isBuffer(chunk) ? chunk.toString(encoding) : chunk;
        if (typeof chunkStr === 'string' && logSink) {
          logSink.write(chunkStr);
          // logSink.flush();
        }
      } catch (err) {
        originalStderrWrite.call(
          process.stderr,
          `[ERROR] Failed to write stderr to output capture file ${outputPath}: ${err}\n`
        );
      }
      return originalStderrWrite.apply(process.stderr, args as any);
    };

    const cleanup = () => {
      if (cleanupCalled) return;
      cleanupCalled = true;
      debugLog(`Cleaning up output capture for: ${outputPath}`);
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      process.removeListener('beforeExit', beforeExitListener);
      logSink?.end(); // Close the sink
    };

    process.on('beforeExit', beforeExitListener);

    debugLog(`Output capture successfully started for: ${outputPath}`);
    return { cleanup };
  } catch (error) {
    originalStderrWrite.call(
      process.stderr,
      `[ERROR] Failed to initialize output capture to ${outputPath}: ${error}\n`
    );
    // Restore originals in case of partial failure during setup
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    // Don't add the listener or return cleanup if setup failed
    return null;
  }
}
