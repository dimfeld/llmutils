import { expect, test, mock, beforeEach } from 'bun:test';

// Mock the modules before importing the functions that use them
const mockIsSshSession = mock(() => false);
const mockOsc52Copy = mock(async () => {});
const mockOsc52Read = mock<() => Promise<string | null>>(async () => null);
const mockClipboardRead = mock(async () => 'clipboardy_text');
const mockClipboardWrite = mock(async () => {});
const mockDebugLog = mock((...args: any[]) => {});

// Setup mock modules
await mock.module('./ssh_detection.js', () => ({
  isSshSession: mockIsSshSession,
}));

await mock.module('./osc52.js', () => ({
  osc52Copy: mockOsc52Copy,
  osc52Read: mockOsc52Read,
}));

// Mock clipboardy module
await mock.module('clipboardy', () => ({
  default: {
    read: mockClipboardRead,
    write: mockClipboardWrite,
  },
  read: mockClipboardRead,
  write: mockClipboardWrite,
}));

await mock.module('../logging.js', () => ({
  debugLog: mockDebugLog,
}));

// Import the functions to test after setting up the mocks
import { read, write } from './clipboard';

// Reset all mocks before each test
beforeEach(() => {
  mockIsSshSession.mockReset();
  mockOsc52Copy.mockReset();
  mockOsc52Read.mockReset();
  mockClipboardRead.mockReset().mockImplementation(async () => 'clipboardy_text');
  mockClipboardWrite.mockReset();
  mockDebugLog.mockReset();
});

// Tests for the write function
test('write - SSH session, OSC52 success', async () => {
  mockIsSshSession.mockImplementation(() => true);

  await write('test_text');

  expect(mockOsc52Copy).toHaveBeenCalledWith('test_text');
  expect(mockClipboardWrite).not.toHaveBeenCalled();
});

test('write - SSH session, OSC52 failure', async () => {
  mockIsSshSession.mockImplementation(() => true);
  mockOsc52Copy.mockImplementationOnce(() => {
    throw new Error('OSC52 copy error');
  });

  await write('test_text');

  expect(mockOsc52Copy).toHaveBeenCalledWith('test_text');
  expect(mockClipboardWrite).toHaveBeenCalledWith('test_text');
  expect(mockDebugLog).toHaveBeenCalled();
});

test('write - not SSH session', async () => {
  mockIsSshSession.mockImplementation(() => false);

  await write('test_text');

  expect(mockClipboardWrite).toHaveBeenCalledWith('test_text');
  expect(mockOsc52Copy).not.toHaveBeenCalled();
});

// Tests for the read function
test('read - SSH session, OSC52 success', async () => {
  mockIsSshSession.mockImplementation(() => true);
  mockOsc52Read.mockImplementationOnce(async () => 'osc_text');

  const result = await read();

  expect(mockOsc52Read).toHaveBeenCalled();
  expect(result).toBe('osc_text');
  expect(mockClipboardRead).not.toHaveBeenCalled();
  expect(mockDebugLog).toHaveBeenCalled();
});

test('read - SSH session, OSC52 returns null', async () => {
  mockIsSshSession.mockImplementation(() => true);
  mockOsc52Read.mockImplementationOnce(async () => null);

  const result = await read();

  expect(mockOsc52Read).toHaveBeenCalled();
  expect(result).toBe('clipboardy_text');
  expect(mockClipboardRead).toHaveBeenCalled();
  expect(mockDebugLog).toHaveBeenCalled();
});

test('read - SSH session, OSC52 throws error', async () => {
  mockIsSshSession.mockImplementation(() => true);
  mockOsc52Read.mockImplementationOnce(() => {
    throw new Error('OSC52 read error');
  });

  const result = await read();

  expect(mockOsc52Read).toHaveBeenCalled();
  expect(result).toBe('clipboardy_text');
  expect(mockClipboardRead).toHaveBeenCalled();
  expect(mockDebugLog).toHaveBeenCalled();
});

test('read - not SSH session', async () => {
  mockIsSshSession.mockImplementation(() => false);

  const result = await read();

  expect(result).toBe('clipboardy_text');
  expect(mockClipboardRead).toHaveBeenCalled();
  expect(mockOsc52Read).not.toHaveBeenCalled();
});
