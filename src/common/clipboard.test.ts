import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const {
  mockIsSshSession,
  mockOsc52Copy,
  mockOsc52Read,
  mockClipboardRead,
  mockClipboardWrite,
  mockDebugLog,
} = vi.hoisted(() => ({
  mockIsSshSession: vi.fn(() => false),
  mockOsc52Copy: vi.fn(async () => {}),
  mockOsc52Read: vi.fn<() => Promise<string | null>>(async () => null),
  mockClipboardRead: vi.fn(async () => 'clipboardy_text'),
  mockClipboardWrite: vi.fn(async () => {}),
  mockDebugLog: vi.fn((..._args: any[]) => {}),
}));

vi.mock('./ssh_detection.js', () => ({
  isSshSession: mockIsSshSession,
}));

vi.mock('./osc52.js', () => ({
  osc52Copy: mockOsc52Copy,
  osc52Read: mockOsc52Read,
}));

vi.mock('clipboardy', () => ({
  default: {
    read: mockClipboardRead,
    write: mockClipboardWrite,
  },
  read: mockClipboardRead,
  write: mockClipboardWrite,
}));

vi.mock('../logging.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logging.js')>();
  return {
    ...actual,
    debugLog: mockDebugLog,
  };
});

import { read, write } from './clipboard';

beforeEach(() => {
  mockIsSshSession.mockReset();
  mockOsc52Copy.mockReset();
  mockOsc52Read.mockReset();
  mockClipboardRead.mockReset().mockImplementation(async () => 'clipboardy_text');
  mockClipboardWrite.mockReset();
  mockDebugLog.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

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
