export async function waitForEnter(otherKeys: string[] = []) {
  // Wait for Enter key
  return new Promise<string>((resolve, reject) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => {
      if (data[0] === 0x0d || data[0] === 0x0a) {
        // Enter key
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve('Enter');
      } else if (data[0] === 0x03) {
        // ctrl-c
        console.warn('Cancelled');
        process.exit(1);
      } else if (otherKeys.includes(String.fromCharCode(data[0]))) {
        // Other key
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(String.fromCharCode(data[0]));
      } else {
        // Any other key - switch to reading pasted input
        process.stdin.setRawMode(false);
        process.stdin.pause();
        void readStdinUntilTimeout(data).then(resolve);
      }
    });
  });
}

/**
 * Reads from stdin until no input has been received for the specified timeout
 * @param initialData The initial data buffer that was already read
 * @param timeoutMs How long to wait for more input before considering the input complete
 * @returns The complete input as a string
 */
export async function readStdinUntilTimeout(initialData: Buffer, timeoutMs = 250): Promise<string> {
  // Start with the initial data
  let input = initialData.toString();
  
  return new Promise<string>((resolve) => {
    let timeoutId: NodeJS.Timeout | null = null;
    
    // Set up the data handler
    const dataHandler = (chunk: Buffer) => {
      // Add the new data to our input
      input += chunk.toString();
      
      // Reset the timeout
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      // Set a new timeout
      timeoutId = setTimeout(() => {
        // No new data received within the timeout period, consider input complete
        process.stdin.removeListener('data', dataHandler);
        process.stdin.pause();
        resolve(input);
      }, timeoutMs);
    };
    
    // Start listening for data
    process.stdin.resume();
    process.stdin.on('data', dataHandler);
    
    // Start the initial timeout
    timeoutId = setTimeout(() => {
      // No new data received within the timeout period, consider input complete
      process.stdin.removeListener('data', dataHandler);
      process.stdin.pause();
      resolve(input);
    }, timeoutMs);
  });
}