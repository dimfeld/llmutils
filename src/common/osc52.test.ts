import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { osc52Copy, osc52Read } from './osc52';

describe('osc52Copy', () => {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let stdoutWriteMock: ReturnType<typeof mock>;

  beforeEach(() => {
    // Setup the mocks
    stdoutWriteMock = mock(() => true);
    process.stdout.write = stdoutWriteMock;
  });

  afterEach(() => {
    // Restore original
    process.stdout.write = originalStdoutWrite;
  });

  test('should send correct OSC52 sequence for basic string', async () => {
    const text = 'hello';
    const expectedBase64 = Buffer.from(text).toString('base64');
    const expectedSequence = `\x1b]52;c;${expectedBase64}\x07`;

    await osc52Copy(text);

    expect(stdoutWriteMock).toHaveBeenCalledTimes(1);
    expect(stdoutWriteMock).toHaveBeenCalledWith(expectedSequence);
  });

  test('should handle empty string', async () => {
    const text = '';
    const expectedBase64 = Buffer.from(text).toString('base64');
    const expectedSequence = `\x1b]52;c;${expectedBase64}\x07`;

    await osc52Copy(text);

    expect(stdoutWriteMock).toHaveBeenCalledTimes(1);
    expect(stdoutWriteMock).toHaveBeenCalledWith(expectedSequence);
  });

  test('should handle string with special characters', async () => {
    const text = 'Special chars: \n\t\r\0\x1B!@#$%^&*()_+';
    const expectedBase64 = Buffer.from(text).toString('base64');
    const expectedSequence = `\x1b]52;c;${expectedBase64}\x07`;

    await osc52Copy(text);

    expect(stdoutWriteMock).toHaveBeenCalledTimes(1);
    expect(stdoutWriteMock).toHaveBeenCalledWith(expectedSequence);
  });

  test('should handle unicode characters', async () => {
    const text = '你好，世界！🌍';
    const expectedBase64 = Buffer.from(text).toString('base64');
    const expectedSequence = `\x1b]52;c;${expectedBase64}\x07`;

    await osc52Copy(text);

    expect(stdoutWriteMock).toHaveBeenCalledTimes(1);
    expect(stdoutWriteMock).toHaveBeenCalledWith(expectedSequence);
  });
});

describe('osc52Read', () => {
  // Store original process properties/methods
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStdin = { ...process.stdin };

  // Mock variables
  let stdoutWriteMock: ReturnType<typeof mock>;
  let setRawModeMock: ReturnType<typeof mock>;
  let resumeMock: ReturnType<typeof mock>;
  let pauseMock: ReturnType<typeof mock>;
  let onMock: ReturnType<typeof mock>;
  let removeListenerMock: ReturnType<typeof mock>;

  // Used to track data event listener
  let dataListener: ((chunk: Buffer) => void) | null = null;
  let errorListener: (() => void) | null = null;

  beforeEach(() => {
    // Setup all mocks
    stdoutWriteMock = mock(() => true);
    setRawModeMock = mock(() => true);
    resumeMock = mock(() => process.stdin);
    pauseMock = mock(() => process.stdin);
    removeListenerMock = mock(() => process.stdin);

    onMock = mock((event: string, listener: any) => {
      if (event === 'data') {
        dataListener = listener;
      } else if (event === 'error') {
        errorListener = listener;
      }
      return process.stdin;
    });

    // Apply mocks
    process.stdout.write = stdoutWriteMock;

    // Override stdin properties and methods
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isRaw', { value: false, configurable: true });
    process.stdin.setRawMode = setRawModeMock;
    process.stdin.resume = resumeMock;
    process.stdin.pause = pauseMock;
    process.stdin.on = onMock;
    process.stdin.removeListener = removeListenerMock;
    process.stdin.isPaused = () => false;
  });

  afterEach(() => {
    // Reset all mocks and listeners
    process.stdout.write = originalStdoutWrite;

    // Restore stdin properties and methods
    Object.keys(originalStdin).forEach((key) => {
      if (key in process.stdin) {
        // @ts-expect-error - dynamic property assignment
        process.stdin[key] = originalStdin[key];
      }
    });

    dataListener = null;
    errorListener = null;
  });

  test('should return null when stdin is not a TTY', async () => {
    // Override TTY status for this test
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const result = await osc52Read();

    expect(result).toBeNull();
    expect(stdoutWriteMock).not.toHaveBeenCalled();
  });

  test('should send the correct OSC52 request sequence', async () => {
    // Create a promise that we can manually resolve
    let promiseResolve: (value: any) => void;
    const manualPromise = new Promise<void>((resolve) => {
      promiseResolve = resolve;
    });

    // Mock setTimeout to resolve our manual promise instead of using actual timeout
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((callback: () => void) => {
      // Store the callback but don't execute it
      void manualPromise.then(() => callback());
      return 1 as any;
    }) as any;

    // Start the read process
    const readPromise = osc52Read();

    // Check if the request was sent
    expect(stdoutWriteMock).toHaveBeenCalledTimes(1);
    expect(stdoutWriteMock).toHaveBeenCalledWith('\x1b]52;c;?\x07');

    // Manually resolve our promise to trigger the timeout
    promiseResolve!(null);

    // Wait for the read operation to complete
    await readPromise;

    // Restore setTimeout
    global.setTimeout = originalSetTimeout;
  });

  test('should properly handle a successful response', async () => {
    const testText = 'hello';
    const base64Text = Buffer.from(testText).toString('base64');

    // Start the read operation
    const readPromise = osc52Read();

    // Verify stdin was properly configured
    expect(setRawModeMock).toHaveBeenCalledWith(true);
    expect(resumeMock).toHaveBeenCalled();
    expect(onMock).toHaveBeenCalledTimes(2);

    // Simulate terminal sending back clipboard data
    if (dataListener) {
      dataListener(Buffer.from(`\x1b]52;c;${base64Text}\x07`));
    }

    const result = await readPromise;

    // Verify we got the expected result
    expect(result).toBe(testText);

    // Verify cleanup was performed
    expect(removeListenerMock).toHaveBeenCalledTimes(2);
    expect(setRawModeMock).toHaveBeenCalledWith(false);
  });

  test('should handle empty or inaccessible clipboard', async () => {
    // Start the read operation
    const readPromise = osc52Read();

    // Simulate terminal responding with '?' indicating empty/inaccessible clipboard
    if (dataListener) {
      dataListener(Buffer.from('\x1b]52;c;?\x07'));
    }

    const result = await readPromise;

    // Verify we got null as expected
    expect(result).toBeNull();
  });

  test('should handle invalid base64 data in response', async () => {
    // Create a promise that we can manually resolve
    let promiseResolve: (value: any) => void;
    const manualPromise = new Promise<void>((resolve) => {
      promiseResolve = resolve;
    });

    // Mock setTimeout to resolve our manual promise instead of using actual timeout
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((callback: () => void) => {
      // Store the callback but don't execute it
      void manualPromise.then(() => callback());
      return 1 as any;
    }) as any;

    // Create a mock for Buffer.from that throws an error on invalid base64
    const originalBufferFrom = Buffer.from.bind(Buffer);
    Buffer.from = mock((input: string, encoding?: string) => {
      if (encoding === 'base64' && input === '!@#invalid-base64$%^&') {
        throw new Error('Invalid base64 string');
      }
      return originalBufferFrom(input, encoding as any);
    }) as any;

    // Start the read operation
    const readPromise = osc52Read();

    // Simulate terminal sending back invalid base64 data
    if (dataListener) {
      dataListener(Buffer.from('\x1b]52;c;!@#invalid-base64$%^&\x07'));
    }

    const result = await readPromise;

    // Verify we got null due to decoding error
    expect(result).toBeNull();

    // Restore original functions
    global.setTimeout = originalSetTimeout;
    Buffer.from = originalBufferFrom;
  });

  test('should handle error event', async () => {
    // Create a promise that we can manually resolve
    let promiseResolve: (value: any) => void;
    const manualPromise = new Promise<void>((resolve) => {
      promiseResolve = resolve;
    });

    // Mock setTimeout to resolve our manual promise instead of using actual timeout
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((callback: () => void) => {
      // Store the callback but don't execute it
      void manualPromise.then(() => callback());
      return 1 as any;
    }) as any;

    // Start the read operation
    const readPromise = osc52Read();

    // Simulate an error event
    if (errorListener) {
      errorListener();
    }

    const result = await readPromise;

    // Verify we got null due to the error
    expect(result).toBeNull();
    expect(removeListenerMock).toHaveBeenCalledTimes(2);

    // Restore setTimeout
    global.setTimeout = originalSetTimeout;
  });

  test('should handle exception during setup', async () => {
    // Make setRawMode throw an error
    setRawModeMock.mockImplementation(() => {
      throw new Error('Test error');
    });

    const result = await osc52Read();

    // Verify we got null due to the setup error
    expect(result).toBeNull();
  });

  test('should handle too much received data without a match', async () => {
    // Create a promise that we can manually resolve
    let promiseResolve: (value: any) => void;
    const manualPromise = new Promise<void>((resolve) => {
      promiseResolve = resolve;
    });

    // Mock setTimeout to resolve our manual promise instead of using actual timeout
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((callback: () => void) => {
      // Store the callback but don't execute it
      void manualPromise.then(() => callback());
      return 1 as any;
    }) as any;

    // Start the read operation
    const readPromise = osc52Read();

    // Simulate receiving large amounts of data without OSC52 pattern
    if (dataListener) {
      const largeData = Buffer.from('x'.repeat(1024 * 1024 + 1));
      dataListener(largeData);
    }

    const result = await readPromise;

    // Verify we got null due to too much data
    expect(result).toBeNull();

    // Restore setTimeout
    global.setTimeout = originalSetTimeout;
  });
});
