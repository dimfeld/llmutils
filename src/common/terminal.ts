export async function waitForEnter() {
  // Wait for Enter key
  await new Promise<void>((resolve, reject) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => {
      if (data[0] === 0x0d || data[0] === 0x0a) {
        // Enter key
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve();
      } else if (data[0] === 0x03) {
        // ctrl-c
        console.warn('Cancelled');
        process.exit(1);
      }
    });
  });
}
