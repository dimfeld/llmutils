import { describe, it, expect, jest, spyOn, beforeEach, afterEach } from 'bun:test';
import { startOutputCapture } from './output_capture';
import { debugLog as originalDebugLog } from '../logging'; // Import original to mock
import type { FileSink } from 'bun';

// Mock the debugLog function
const mockDebugLog = jest.fn();
jest.mock('../logging', () => ({
  debugLog: (...args: any[]) => mockDebugLog(...args),
}));

describe('startOutputCapture', () => {
  const outputPath = '/fake/path/output.log';
  let mockSink: { write: jest.Mock; end: jest.Mock; flush: jest.Mock };
  let mockFile: { writer: jest.Mock };
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;
  let mockStdoutWrite: jest.SpyInstance;
  let mockStderrWrite: jest.SpyInstance;
  let mockProcessOn: jest.SpyInstance;
  let mockProcessRemoveListener: jest.SpyInstance;
  let mockBunFile: jest.SpyInstance;

  beforeEach(() => {
    // Store original methods
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;

    // Mock Bun.file and its writer
    mockSink = {
      write: jest.fn(),
      end: jest.fn(),
      flush: jest.fn(), // Bun's FileSink has flush, mock it too
    };
    mockFile = {
      writer: jest.fn(() => mockSink as unknown as FileSink),
    };
    // Use spyOn for Bun.file as it's a global function
    mockBunFile = spyOn(Bun, 'file').mockReturnValue(mockFile as any);

    // Mock process methods using spyOn
    mockStdoutWrite = spyOn(process.stdout, 'write').mockImplementation((...args: any[]) => {
      // Default mock implementation just returns true like the original
      return true;
    });
    mockStderrWrite = spyOn(process.stderr, 'write').mockImplementation((...args: any[]) => {
      return true;
    });
    mockProcessOn = spyOn(process, 'on');
    mockProcessRemoveListener = spyOn(process, 'removeListener');

    // Reset debugLog mock calls
    mockDebugLog.mockClear();
  });

  afterEach(() => {
    // Restore all mocks and original methods
    jest.restoreAllMocks();
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });

  it('should successfully set up output capture', async () => {
    const result = await startOutputCapture(outputPath);

    expect(result).not.toBeNull();
    expect(typeof result?.cleanup).toBe('function');

    expect(mockBunFile).toHaveBeenCalledWith(outputPath);
    expect(mockFile.writer).toHaveBeenCalledTimes(1);

    // Check if write methods were replaced (they are different from the spied originals)
    expect(process.stdout.write).not.toBe(mockStdoutWrite);
    expect(process.stderr.write).not.toBe(mockStderrWrite);

    // Check if 'beforeExit' listener was registered
    expect(mockProcessOn).toHaveBeenCalledWith('beforeExit', expect.any(Function));

    expect(mockDebugLog).toHaveBeenCalledWith(
      `Attempting to start output capture to: ${outputPath}`
    );
    expect(mockDebugLog).toHaveBeenCalledWith(
      `Output capture successfully started for: ${outputPath}`
    );

    // Cleanup to avoid interference with other tests if something goes wrong
    result?.cleanup();
  });

  it('should redirect stdout to the file sink and original stdout', async () => {
    const result = await startOutputCapture(outputPath);
    expect(result).not.toBeNull();

    const testString = 'hello stdout';
    const testBuffer = Buffer.from('buffer stdout');

    // Call the *new* process.stdout.write
    process.stdout.write(testString);
    process.stdout.write(testBuffer);

    // Verify original stdout (mocked by spyOn) was called
    expect(mockStdoutWrite).toHaveBeenCalledWith(testString);
    expect(mockStdoutWrite).toHaveBeenCalledWith(testBuffer);

    // Verify sink's write method was called
    expect(mockSink.write).toHaveBeenCalledWith(testString);
    expect(mockSink.write).toHaveBeenCalledWith(testBuffer.toString()); // Buffers are converted to strings

    result?.cleanup();
  });

  it('should redirect stderr to the file sink and original stderr', async () => {
    const result = await startOutputCapture(outputPath);
    expect(result).not.toBeNull();

    const testString = 'hello stderr';
    const testBuffer = Buffer.from('buffer stderr');

    // Call the *new* process.stderr.write
    process.stderr.write(testString);
    process.stderr.write(testBuffer);

    // Verify original stderr (mocked by spyOn) was called
    expect(mockStderrWrite).toHaveBeenCalledWith(testString);
    expect(mockStderrWrite).toHaveBeenCalledWith(testBuffer);

    // Verify sink's write method was called
    expect(mockSink.write).toHaveBeenCalledWith(testString);
    expect(mockSink.write).toHaveBeenCalledWith(testBuffer.toString());

    result?.cleanup();
  });

  it('should cleanup correctly', async () => {
    const result = await startOutputCapture(outputPath);
    expect(result).not.toBeNull();

    // Capture the installed listener
    const beforeExitListener = mockProcessOn.mock.calls.find(
      (call) => call[0] === 'beforeExit'
    )?.[1];
    expect(beforeExitListener).toBeDefined();

    // Call cleanup
    result!.cleanup();

    // Verify original write methods are restored
    expect(process.stdout.write).toBe(originalStdoutWrite); // Check identity, not just the spy
    expect(process.stderr.write).toBe(originalStderrWrite);

    // Verify sink.end() was called
    expect(mockSink.end).toHaveBeenCalledTimes(1);

    // Verify the 'beforeExit' listener was removed
    expect(mockProcessRemoveListener).toHaveBeenCalledWith('beforeExit', beforeExitListener);

    expect(mockDebugLog).toHaveBeenCalledWith(`Cleaning up output capture for: ${outputPath}`);

    // Calling cleanup again should do nothing
    result!.cleanup();
    expect(mockSink.end).toHaveBeenCalledTimes(1); // Should not be called again
    expect(mockProcessRemoveListener).toHaveBeenCalledTimes(1);
  });

  it('should handle errors during writer creation', async () => {
    const error = new Error('Failed to create writer');
    mockFile.writer.mockImplementation(() => {
      throw error;
    });

    const result = await startOutputCapture(outputPath);

    expect(result).toBeNull();

    // Verify write methods were *not* replaced permanently
    expect(process.stdout.write).toBe(originalStdoutWrite);
    expect(process.stderr.write).toBe(originalStderrWrite);

    // Verify no listener was attached
    expect(mockProcessOn).not.toHaveBeenCalledWith('beforeExit', expect.any(Function));

    // Verify error was logged to original stderr
    expect(mockStderrWrite).toHaveBeenCalledWith(
      `[ERROR] Failed to initialize output capture to ${outputPath}: ${error}\n`
    );
  });

  it('should call sink.end() via the beforeExit listener', async () => {
    await startOutputCapture(outputPath);

    const beforeExitListener = mockProcessOn.mock.calls.find(
      (call) => call[0] === 'beforeExit'
    )?.[1];
    expect(beforeExitListener).toBeDefined();

    // Simulate the beforeExit event by calling the listener
    beforeExitListener();

    expect(mockSink.end).toHaveBeenCalledTimes(1);
    expect(mockDebugLog).toHaveBeenCalledWith(
      `Output capture: beforeExit triggered, ensuring sink is closed for ${outputPath}.`
    );
  });
});
