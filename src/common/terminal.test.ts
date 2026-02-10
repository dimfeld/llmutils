import { expect, test, mock, beforeEach, afterAll } from 'bun:test';
import { EventEmitter } from 'events';
import { waitForEnter, readStdinUntilTimeout } from './terminal';

// Mock process.stdin
const mockStdin = new EventEmitter() as (typeof process)['stdin'];
// @ts-expect-error setting up bad mock
mockStdin.setRawMode = mock(() => true);
// @ts-expect-error setting up bad mock
mockStdin.resume = mock(() => {});
// @ts-expect-error setting up bad mock
mockStdin.pause = mock(() => {});

// Backup original stdin
const originalStdin = process.stdin;

// Setup and teardown
beforeEach(() => {
  // Replace process.stdin with our mock
  Object.defineProperty(process, 'stdin', {
    value: mockStdin,
    writable: true,
  });

  // Reset mocks
  // @ts-expect-error setting up bad mock
  mockStdin.setRawMode.mockReset();
  // @ts-expect-error setting up bad mock
  mockStdin.resume.mockReset();
  // @ts-expect-error setting up bad mock
  mockStdin.pause.mockReset();
});

// Restore original stdin after all tests
afterAll(() => {
  Object.defineProperty(process, 'stdin', {
    value: originalStdin,
    writable: true,
  });
});

// Tests for waitForEnter
test('waitForEnter - Enter key', async () => {
  const promise = waitForEnter();

  // Emit Enter key press
  mockStdin.emit('data', Buffer.from([0x0d]));

  const result = await promise;
  expect(result).toBe('');
  // eslint-disable-next-line @typescript-eslint/unbound-method
  expect(mockStdin.setRawMode).toHaveBeenCalledWith(true);
  // eslint-disable-next-line @typescript-eslint/unbound-method
  expect(mockStdin.pause).toHaveBeenCalled();
});

test('waitForEnter - any other key triggers stdin reading', async () => {
  // Mock setTimeout to execute immediately
  const originalSetTimeout = global.setTimeout;
  // @ts-expect-error gross mock
  global.setTimeout = mock((fn) => {
    fn();
    return {} as any;
  });

  try {
    const promise = waitForEnter();

    // Emit 'x' key press (not in allowedKeys)
    mockStdin.emit('data', Buffer.from('x'));

    // Wait a bit for the readStdinUntilTimeout to complete
    setTimeout(() => {
      // No more input, timeout will resolve
    }, 10);

    const result = await promise;
    expect(result).toBe('x');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStdin.setRawMode).toHaveBeenCalledWith(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStdin.pause).toHaveBeenCalled();
  } finally {
    // Restore original setTimeout
    global.setTimeout = originalSetTimeout;
  }
});

// Tests for readStdinUntilTimeout
test('readStdinUntilTimeout - basic functionality', async () => {
  // Create a deferred promise
  let resolveFn: (value: string) => void;
  const resultPromise = new Promise<string>((resolve) => {
    resolveFn = resolve;
  });

  // Mock the readStdinUntilTimeout function
  const originalFn = readStdinUntilTimeout;
  (globalThis as any).readStdinUntilTimeout = mock((data: Buffer) => {
    resolveFn(data.toString());
    return Promise.resolve(data.toString());
  });

  try {
    const initialData = Buffer.from('initial');
    const promise = waitForEnter();

    // Simulate typing a key that's not Enter and not in the allowed keys
    mockStdin.emit('data', Buffer.from('x'));

    const result = await promise;
    expect(result).toBe('x');
  } finally {
    // Restore original function
    (globalThis as any).readStdinUntilTimeout = originalFn;
  }
});

test('readStdinUntilTimeout - with additional data', async () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  let timeoutFn: Function | undefined;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  let dataHandler: Function | undefined;

  // Mock stdin.on to capture the data handler
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalOn = mockStdin.on;
  mockStdin.on = mock((event, handler) => {
    if (event === 'data') dataHandler = handler;
    return mockStdin;
  });

  // Mock setTimeout
  const originalSetTimeout = global.setTimeout;
  const mockSetTimeout = mock((fn: () => any) => {
    timeoutFn = fn;
    return 1 as any;
  });
  // @ts-expect-error mocking
  global.setTimeout = mockSetTimeout;

  try {
    // Start the function
    const initialData = Buffer.from('initial');
    const promise = readStdinUntilTimeout(initialData);

    // Now that we have the data handler, manually simulate data events
    if (dataHandler) dataHandler(Buffer.from(' more'));

    // Then trigger timeout to resolve the promise
    if (timeoutFn) timeoutFn();

    const result = await promise;
    expect(result).toBe('initial more');
  } finally {
    // Restore originals
    global.setTimeout = originalSetTimeout;
    mockStdin.on = originalOn;
  }
});
