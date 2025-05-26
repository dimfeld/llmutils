import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { isSshSession } from './ssh_detection';

describe.skipIf(!process.env.TEST_SSH_DETECTION)('isSshSession', () => {
  // Save original environment variables
  const originalEnv = { ...process.env };

  // Clear SSH-related environment variables before each test
  beforeEach(() => {
    delete process.env.SSH_CLIENT;
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_TTY;
  });

  // Restore original environment variables after each test
  afterEach(() => {
    // Reset to original state
    process.env = { ...originalEnv };
  });

  test('should return false when no SSH-related environment variables are set', () => {
    expect(isSshSession()).toBe(false);
  });

  test('should return true when SSH_CLIENT is set', () => {
    process.env.SSH_CLIENT = '192.168.1.1 52415 22';
    expect(isSshSession()).toBe(true);
  });

  test('should return true when SSH_CONNECTION is set', () => {
    process.env.SSH_CONNECTION = '192.168.1.1 52415 192.168.1.2 22';
    expect(isSshSession()).toBe(true);
  });

  test('should return true when SSH_TTY is set', () => {
    process.env.SSH_TTY = '/dev/pts/0';
    expect(isSshSession()).toBe(true);
  });

  test('should return true when multiple SSH-related environment variables are set', () => {
    process.env.SSH_CLIENT = '192.168.1.1 52415 22';
    process.env.SSH_CONNECTION = '192.168.1.1 52415 192.168.1.2 22';
    process.env.SSH_TTY = '/dev/pts/0';
    expect(isSshSession()).toBe(true);
  });

  test('should return false when SSH_CLIENT is an empty string', () => {
    process.env.SSH_CLIENT = '';
    expect(isSshSession()).toBe(false);
  });

  test('should return false when SSH_CONNECTION is an empty string', () => {
    process.env.SSH_CONNECTION = '';
    expect(isSshSession()).toBe(false);
  });

  test('should return false when SSH_TTY is an empty string', () => {
    process.env.SSH_TTY = '';
    expect(isSshSession()).toBe(false);
  });
});
