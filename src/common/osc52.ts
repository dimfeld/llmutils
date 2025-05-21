/**
 * Implementation of OSC52 clipboard operations for terminal use
 */

/**
 * Copies text to the clipboard using OSC52 escape sequence
 *
 * This sends a special escape sequence to the terminal which instructs it
 * to set its clipboard to the provided text.
 *
 * @param text The text to copy to the clipboard
 */
export async function osc52Copy(text: string): Promise<void> {
  // Encode the text as base64
  const base64EncodedText = Buffer.from(text).toString('base64');

  // Construct the OSC52 escape sequence
  // \x1b is the escape character, 52 is the OSC code for clipboard operations,
  // 'c' specifies the clipboard selection, and \x07 is the sequence terminator
  const osc52Sequence = `\x1b]52;c;${base64EncodedText}\x07`;

  // Write the sequence to stdout
  process.stdout.write(osc52Sequence);
}

/**
 * Attempts to read text from the clipboard using OSC52 escape sequence
 *
 * This function sends a request to the terminal for clipboard content,
 * then attempts to read and parse the response.
 *
 * @returns A promise that resolves to the clipboard text or null if the operation fails
 */
export async function osc52Read(): Promise<string | null> {
  // If stdin is not a TTY, we can't interact with it for OSC52
  if (!process.stdin.isTTY) {
    return null;
  }

  // Store the original state of stdin
  const originalIsRaw = process.stdin.isRaw;
  const originalIsPaused = process.stdin.isPaused();

  // Function to restore stdin to its original state
  const restoreStdin = () => {
    try {
      process.stdin.setRawMode(originalIsRaw);
      if (originalIsPaused) {
        process.stdin.pause();
      }
    } catch (e) {
      // Ignore errors during cleanup
    }
  };

  return new Promise<string | null>((resolve) => {
    let receivedData = '';

    // Set a timeout for the operation
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 500);

    // Handler for incoming data
    const onData = (chunk: Buffer) => {
      receivedData += chunk.toString();

      // Check for the expected OSC52 response format
      // eslint-disable-next-line no-control-regex
      const match = receivedData.match(/\x1b\]52;c;([^\x07]*)\x07/);

      if (match) {
        // We got a valid response
        cleanup();

        try {
          // Extract and decode the base64 data
          const base64Data = match[1];
          if (base64Data === '?') {
            // Terminal responded but clipboard is empty or cannot be accessed
            resolve(null);
          } else {
            const decodedText = Buffer.from(base64Data, 'base64').toString('utf8');
            resolve(decodedText);
          }
        } catch (error) {
          // Failed to decode the response
          resolve(null);
        }
      } else if (receivedData.length > 1024 * 1024) {
        // Received too much data without a match, likely not an OSC52 response
        cleanup();
        resolve(null);
      }
    };

    // Handler for errors
    const onError = () => {
      cleanup();
      resolve(null);
    };

    // Setup cleanup function to handle any termination path
    const cleanup = () => {
      clearTimeout(timeoutId);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('error', onError);
      restoreStdin();
    };

    try {
      // Prepare stdin for raw input
      process.stdin.setRawMode(true);
      process.stdin.resume();

      // Attach event listeners
      process.stdin.on('data', onData);
      process.stdin.on('error', onError);

      // Send the OSC52 request sequence to stdout
      process.stdout.write('\x1b]52;c;?\x07');
    } catch (error) {
      // If we can't set up the stdin properly, fail gracefully
      cleanup();
      resolve(null);
    }
  });
}
