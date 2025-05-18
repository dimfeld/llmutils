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
      }
    });
  });
}
