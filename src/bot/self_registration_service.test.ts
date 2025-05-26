import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { completeRegistration } from './self_registration_service.js';

// Mock dependencies
const mockGetPendingVerificationForDiscordUser = mock();
const mockMarkAsVerified = mock();
const mockVerifyGist = mock();

mock.module('./db/user_mappings_manager.js', () => ({
  getPendingVerificationForDiscordUser: mockGetPendingVerificationForDiscordUser,
  markAsVerified: mockMarkAsVerified,
}));

mock.module('../common/github/gist_service.js', () => ({
  verifyGist: mockVerifyGist,
}));

describe('completeRegistration', () => {
  beforeEach(() => {
    mockGetPendingVerificationForDiscordUser.mockReset();
    mockMarkAsVerified.mockReset();
    mockVerifyGist.mockReset();
  });

  it('should complete registration successfully with valid Gist', async () => {
    const discordUserId = 'discord123';
    const gistUrl = 'https://gist.github.com/testuser/abc123';

    mockGetPendingVerificationForDiscordUser.mockResolvedValue({
      githubUsername: 'testuser',
      discordUserId: 'discord123',
      verified: 0,
      verificationCode: 'VERIFY123',
      verificationCodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      mappedAt: new Date(),
      mappedBy: 'self',
    });

    mockVerifyGist.mockResolvedValue({
      verified: true,
      message: 'Gist verified successfully.',
    });

    mockMarkAsVerified.mockResolvedValue(undefined);

    const result = await completeRegistration(discordUserId, gistUrl);

    expect(result.success).toBe(true);
    expect(result.message).toBe('GitHub account @testuser successfully linked and verified!');
    expect(mockGetPendingVerificationForDiscordUser).toHaveBeenCalledWith(discordUserId);
    expect(mockVerifyGist).toHaveBeenCalledWith(gistUrl, 'testuser', 'VERIFY123');
    expect(mockMarkAsVerified).toHaveBeenCalledWith('testuser', discordUserId);
  });

  it('should fail when no pending verification exists', async () => {
    const discordUserId = 'discord123';
    const gistUrl = 'https://gist.github.com/testuser/abc123';

    mockGetPendingVerificationForDiscordUser.mockResolvedValue(null);

    const result = await completeRegistration(discordUserId, gistUrl);

    expect(result.success).toBe(false);
    expect(result.message).toContain('No pending verification found');
    expect(mockVerifyGist).not.toHaveBeenCalled();
    expect(mockMarkAsVerified).not.toHaveBeenCalled();
  });

  it('should fail when verification code is missing', async () => {
    const discordUserId = 'discord123';
    const gistUrl = 'https://gist.github.com/testuser/abc123';

    mockGetPendingVerificationForDiscordUser.mockResolvedValue({
      githubUsername: 'testuser',
      discordUserId: 'discord123',
      verified: 0,
      verificationCode: null,
      verificationCodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      mappedAt: new Date(),
      mappedBy: 'self',
    });

    const result = await completeRegistration(discordUserId, gistUrl);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid verification state');
    expect(mockVerifyGist).not.toHaveBeenCalled();
    expect(mockMarkAsVerified).not.toHaveBeenCalled();
  });

  it('should fail when Gist verification fails', async () => {
    const discordUserId = 'discord123';
    const gistUrl = 'https://gist.github.com/testuser/abc123';

    mockGetPendingVerificationForDiscordUser.mockResolvedValue({
      githubUsername: 'testuser',
      discordUserId: 'discord123',
      verified: 0,
      verificationCode: 'VERIFY123',
      verificationCodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      mappedAt: new Date(),
      mappedBy: 'self',
    });

    mockVerifyGist.mockResolvedValue({
      verified: false,
      message: 'Gist owner mismatch',
    });

    const result = await completeRegistration(discordUserId, gistUrl);

    expect(result.success).toBe(false);
    expect(result.message).toBe('Verification failed: Gist owner mismatch');
    expect(mockMarkAsVerified).not.toHaveBeenCalled();
  });

  it('should handle database errors gracefully', async () => {
    const discordUserId = 'discord123';
    const gistUrl = 'https://gist.github.com/testuser/abc123';

    mockGetPendingVerificationForDiscordUser.mockResolvedValue({
      githubUsername: 'testuser',
      discordUserId: 'discord123',
      verified: 0,
      verificationCode: 'VERIFY123',
      verificationCodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      mappedAt: new Date(),
      mappedBy: 'self',
    });

    mockVerifyGist.mockResolvedValue({
      verified: true,
      message: 'Gist verified successfully.',
    });

    mockMarkAsVerified.mockRejectedValue(new Error('Database error'));

    const result = await completeRegistration(discordUserId, gistUrl);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Error during registration: Database error');
  });

  it('should handle getPendingVerificationForDiscordUser errors', async () => {
    const discordUserId = 'discord123';
    const gistUrl = 'https://gist.github.com/testuser/abc123';

    mockGetPendingVerificationForDiscordUser.mockRejectedValue(
      new Error('Database connection failed')
    );

    const result = await completeRegistration(discordUserId, gistUrl);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Error during registration: Database connection failed');
    expect(mockVerifyGist).not.toHaveBeenCalled();
    expect(mockMarkAsVerified).not.toHaveBeenCalled();
  });

  it('should handle verifyGist errors', async () => {
    const discordUserId = 'discord123';
    const gistUrl = 'https://gist.github.com/testuser/abc123';

    mockGetPendingVerificationForDiscordUser.mockResolvedValue({
      githubUsername: 'testuser',
      discordUserId: 'discord123',
      verified: 0,
      verificationCode: 'VERIFY123',
      verificationCodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      mappedAt: new Date(),
      mappedBy: 'self',
    });

    mockVerifyGist.mockRejectedValue(new Error('GitHub API error'));

    const result = await completeRegistration(discordUserId, gistUrl);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Error during registration: GitHub API error');
    expect(mockMarkAsVerified).not.toHaveBeenCalled();
  });
});
