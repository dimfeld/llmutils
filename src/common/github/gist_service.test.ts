import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { verifyGist } from './gist_service.js';

// Mock octokit
const mockGistGet = mock();

mock.module('octokit', () => ({
  Octokit: class {
    rest = {
      gists: {
        get: mockGistGet,
      },
    };
  },
}));

describe('verifyGist', () => {
  beforeEach(() => {
    mockGistGet.mockReset();
  });

  it('should verify a valid Gist with correct owner and code', async () => {
    const gistUrl = 'https://gist.github.com/testuser/abc123def456';
    const expectedUsername = 'testuser';
    const expectedCode = 'VERIFY123';

    mockGistGet.mockResolvedValue({
      data: {
        owner: { login: 'testuser' },
        files: {
          'verification.txt': {
            content: 'VERIFY123',
          },
        },
      },
    });

    const result = await verifyGist(gistUrl, expectedUsername, expectedCode);

    expect(result.verified).toBe(true);
    expect(result.message).toBe('Gist verified successfully.');
    expect(mockGistGet).toHaveBeenCalledWith({ gist_id: 'abc123def456' });
  });

  it('should handle case-insensitive username matching', async () => {
    const gistUrl = 'https://gist.github.com/TestUser/abc123def456';
    const expectedUsername = 'testuser';
    const expectedCode = 'VERIFY123';

    mockGistGet.mockResolvedValue({
      data: {
        owner: { login: 'TestUser' },
        files: {
          'verification.txt': {
            content: 'VERIFY123',
          },
        },
      },
    });

    const result = await verifyGist(gistUrl, expectedUsername, expectedCode);

    expect(result.verified).toBe(true);
    expect(result.message).toBe('Gist verified successfully.');
  });

  it('should reject invalid Gist URL format', async () => {
    const invalidUrl = 'https://github.com/testuser/repo';
    const expectedUsername = 'testuser';
    const expectedCode = 'VERIFY123';

    const result = await verifyGist(invalidUrl, expectedUsername, expectedCode);

    expect(result.verified).toBe(false);
    expect(result.message).toContain('Invalid Gist URL format');
    expect(mockGistGet).not.toHaveBeenCalled();
  });

  it('should handle Gist not found (404)', async () => {
    const gistUrl = 'https://gist.github.com/testuser/abc123def456';
    const expectedUsername = 'testuser';
    const expectedCode = 'VERIFY123';

    mockGistGet.mockRejectedValue({ status: 404 });

    const result = await verifyGist(gistUrl, expectedUsername, expectedCode);

    expect(result.verified).toBe(false);
    expect(result.message).toContain('Gist not found');
  });

  it('should reject Gist with wrong owner', async () => {
    const gistUrl = 'https://gist.github.com/testuser/abc123def456';
    const expectedUsername = 'testuser';
    const expectedCode = 'VERIFY123';

    mockGistGet.mockResolvedValue({
      data: {
        owner: { login: 'wronguser' },
        files: {
          'verification.txt': {
            content: 'VERIFY123',
          },
        },
      },
    });

    const result = await verifyGist(gistUrl, expectedUsername, expectedCode);

    expect(result.verified).toBe(false);
    expect(result.message).toContain('Gist owner mismatch');
    expect(result.message).toContain('Expected: testuser, Found: wronguser');
  });

  it('should reject Gist with wrong verification code', async () => {
    const gistUrl = 'https://gist.github.com/testuser/abc123def456';
    const expectedUsername = 'testuser';
    const expectedCode = 'VERIFY123';

    mockGistGet.mockResolvedValue({
      data: {
        owner: { login: 'testuser' },
        files: {
          'verification.txt': {
            content: 'WRONGCODE',
          },
        },
      },
    });

    const result = await verifyGist(gistUrl, expectedUsername, expectedCode);

    expect(result.verified).toBe(false);
    expect(result.message).toContain('Verification code not found in Gist');
  });

  it('should reject Gist with no files', async () => {
    const gistUrl = 'https://gist.github.com/testuser/abc123def456';
    const expectedUsername = 'testuser';
    const expectedCode = 'VERIFY123';

    mockGistGet.mockResolvedValue({
      data: {
        owner: { login: 'testuser' },
        files: {},
      },
    });

    const result = await verifyGist(gistUrl, expectedUsername, expectedCode);

    expect(result.verified).toBe(false);
    expect(result.message).toContain('Gist has no files');
  });

  it('should accept Gist URL without username in path', async () => {
    const gistUrl = 'https://gist.github.com/abc123def456';
    const expectedUsername = 'testuser';
    const expectedCode = 'VERIFY123';

    mockGistGet.mockResolvedValue({
      data: {
        owner: { login: 'testuser' },
        files: {
          'verification.txt': {
            content: 'VERIFY123',
          },
        },
      },
    });

    const result = await verifyGist(gistUrl, expectedUsername, expectedCode);

    expect(result.verified).toBe(true);
    expect(result.message).toBe('Gist verified successfully.');
    expect(mockGistGet).toHaveBeenCalledWith({ gist_id: 'abc123def456' });
  });

  it('should trim whitespace from verification code', async () => {
    const gistUrl = 'https://gist.github.com/testuser/abc123def456';
    const expectedUsername = 'testuser';
    const expectedCode = 'VERIFY123';

    mockGistGet.mockResolvedValue({
      data: {
        owner: { login: 'testuser' },
        files: {
          'verification.txt': {
            content: '  VERIFY123  \n',
          },
        },
      },
    });

    const result = await verifyGist(gistUrl, expectedUsername, expectedCode);

    expect(result.verified).toBe(true);
    expect(result.message).toBe('Gist verified successfully.');
  });

  it('should check all files for verification code', async () => {
    const gistUrl = 'https://gist.github.com/testuser/abc123def456';
    const expectedUsername = 'testuser';
    const expectedCode = 'VERIFY123';

    mockGistGet.mockResolvedValue({
      data: {
        owner: { login: 'testuser' },
        files: {
          'readme.md': {
            content: 'Some readme content',
          },
          'verification.txt': {
            content: 'VERIFY123',
          },
          'other.txt': {
            content: 'Other content',
          },
        },
      },
    });

    const result = await verifyGist(gistUrl, expectedUsername, expectedCode);

    expect(result.verified).toBe(true);
    expect(result.message).toBe('Gist verified successfully.');
  });

  it('should handle API errors gracefully', async () => {
    const gistUrl = 'https://gist.github.com/testuser/abc123def456';
    const expectedUsername = 'testuser';
    const expectedCode = 'VERIFY123';

    mockGistGet.mockRejectedValue(new Error('Network error'));

    const result = await verifyGist(gistUrl, expectedUsername, expectedCode);

    expect(result.verified).toBe(false);
    expect(result.message).toContain('Error verifying Gist: Network error');
  });
});
