import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  upsertPendingVerification,
  getPendingVerification,
  getPendingVerificationByCode,
  getPendingVerificationForDiscordUser,
  markAsVerified,
  getUserMappingByGithubUsername,
  UserMapping,
} from './user_mappings_manager.js';

// Mock the database module
let mockInsertValues: any;
let mockUpdateSet: any;
let mockSelectResult: any[] = [];

mock.module('./index.js', () => {
  const mockDb = {
    insert: mock(() => ({
      values: mock((values: any) => {
        mockInsertValues = values;
        return {
          onConflictDoUpdate: mock((opts: any) => {
            mockUpdateSet = opts.set;
            return Promise.resolve();
          }),
        };
      }),
    })),
    update: mock(() => ({
      set: mock((values: any) => {
        mockUpdateSet = values;
        return {
          where: mock(() => Promise.resolve()),
        };
      }),
    })),
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(() => mockSelectResult),
        })),
      })),
    })),
  };

  return {
    db: mockDb,
    userMappings: {},
  };
});

describe('User Mappings Verification Functions', () => {
  beforeEach(() => {
    // Reset mocks and state
    mock.restore();
    mockInsertValues = undefined;
    mockUpdateSet = undefined;
    mockSelectResult = [];
  });

  afterEach(() => {
    mock.restore();
  });

  describe('upsertPendingVerification', () => {
    it('should create a new pending verification', async () => {
      const discordUserId = 'discord123';
      const githubUsername = 'testuser';
      const code = 'ABC123';
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

      // Mock getUserMappingByGithubUsername to return no existing mapping
      mockSelectResult = [];

      await upsertPendingVerification(discordUserId, githubUsername, code, expiresAt);

      expect(mockInsertValues).toEqual({
        githubUsername,
        discordUserId,
        verified: 0,
        verificationCode: code,
        verificationCodeExpiresAt: expiresAt,
        mappedBy: 'self',
        mappedAt: expect.any(Date),
      });
    });

    it('should update an existing unverified mapping', async () => {
      const discordUserId = 'discord123';
      const githubUsername = 'testuser';
      const code1 = 'ABC123';
      const code2 = 'XYZ789';
      const expiresAt1 = new Date(Date.now() + 5 * 60 * 1000);
      const expiresAt2 = new Date(Date.now() + 10 * 60 * 1000);

      // Mock existing unverified mapping
      mockSelectResult = [];

      // First call
      await upsertPendingVerification(discordUserId, githubUsername, code1, expiresAt1);

      // Reset for second call
      mockInsertValues = undefined;
      mockUpdateSet = undefined;

      // Update with new code
      await upsertPendingVerification(discordUserId, githubUsername, code2, expiresAt2);

      expect(mockUpdateSet).toEqual({
        discordUserId,
        verified: 0,
        verificationCode: code2,
        verificationCodeExpiresAt: expiresAt2,
        mappedBy: 'self',
        mappedAt: expect.any(Date),
      });
    });

    it('should throw error if GitHub username is verified for different Discord user', async () => {
      const discordUserId1 = 'discord123';
      const discordUserId2 = 'discord456';
      const githubUsername = 'testuser';
      const code = 'ABC123';
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      // Mock existing verified mapping for different user
      mockSelectResult = [
        {
          githubUsername,
          discordUserId: discordUserId1,
          verified: 1,
          verificationCode: null,
          verificationCodeExpiresAt: null,
          mappedAt: new Date(),
          mappedBy: 'self',
        },
      ];

      // Try to create mapping for second user
      await expect(
        upsertPendingVerification(discordUserId2, githubUsername, 'XYZ789', expiresAt)
      ).rejects.toThrow('already verified for a different Discord user');
    });
  });

  describe('getPendingVerification', () => {
    it('should retrieve a valid pending verification', async () => {
      const discordUserId = 'discord123';
      const githubUsername = 'testuser';
      const code = 'ABC123';
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      const mockMapping = {
        githubUsername,
        discordUserId,
        verified: 0,
        verificationCode: code,
        verificationCodeExpiresAt: expiresAt,
        mappedAt: new Date(),
        mappedBy: 'self',
      };

      mockSelectResult = [mockMapping];

      const mapping = await getPendingVerification(githubUsername, discordUserId);
      expect(mapping).not.toBeNull();
      expect(mapping?.githubUsername).toBe(githubUsername);
      expect(mapping?.discordUserId).toBe(discordUserId);
      expect(mapping?.verificationCode).toBe(code);
    });

    it('should return null for expired verification', async () => {
      const discordUserId = 'discord123';
      const githubUsername = 'testuser';
      const code = 'ABC123';
      const expiresAt = new Date(Date.now() - 1000); // Already expired

      const mockMapping = {
        githubUsername,
        discordUserId,
        verified: 0,
        verificationCode: code,
        verificationCodeExpiresAt: expiresAt,
        mappedAt: new Date(),
        mappedBy: 'self',
      };

      mockSelectResult = [mockMapping];

      const mapping = await getPendingVerification(githubUsername, discordUserId);
      expect(mapping).toBeNull();
    });

    it('should return null for verified mapping', async () => {
      const discordUserId = 'discord123';
      const githubUsername = 'testuser';

      // Mock returns no results since we filter for verified = 0
      mockSelectResult = [];

      const mapping = await getPendingVerification(githubUsername, discordUserId);
      expect(mapping).toBeNull();
    });

    it('should return null for wrong Discord user', async () => {
      const discordUserId = 'discord123';
      const githubUsername = 'testuser';

      // Mock returns no results since we filter by discordUserId
      mockSelectResult = [];

      const mapping = await getPendingVerification(githubUsername, 'differentDiscordId');
      expect(mapping).toBeNull();
    });
  });

  describe('getPendingVerificationByCode', () => {
    it('should retrieve a valid pending verification by code', async () => {
      const discordUserId = 'discord123';
      const githubUsername = 'testuser';
      const code = 'ABC123';
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      const mockMapping = {
        githubUsername,
        discordUserId,
        verified: 0,
        verificationCode: code,
        verificationCodeExpiresAt: expiresAt,
        mappedAt: new Date(),
        mappedBy: 'self',
      };

      mockSelectResult = [mockMapping];

      const mapping = await getPendingVerificationByCode(code);
      expect(mapping).not.toBeNull();
      expect(mapping?.githubUsername).toBe(githubUsername);
      expect(mapping?.discordUserId).toBe(discordUserId);
      expect(mapping?.verificationCode).toBe(code);
    });

    it('should return null for expired verification', async () => {
      const code = 'ABC123';
      const expiresAt = new Date(Date.now() - 1000); // Already expired

      const mockMapping = {
        githubUsername: 'testuser',
        discordUserId: 'discord123',
        verified: 0,
        verificationCode: code,
        verificationCodeExpiresAt: expiresAt,
        mappedAt: new Date(),
        mappedBy: 'self',
      };

      mockSelectResult = [mockMapping];

      const mapping = await getPendingVerificationByCode(code);
      expect(mapping).toBeNull();
    });

    it('should return null for verified mapping', async () => {
      const code = 'ABC123';

      // Mock returns no results since we filter for verified = 0
      mockSelectResult = [];

      const mapping = await getPendingVerificationByCode(code);
      expect(mapping).toBeNull();
    });

    it('should return null for non-existent code', async () => {
      mockSelectResult = [];

      const mapping = await getPendingVerificationByCode('NONEXISTENT');
      expect(mapping).toBeNull();
    });
  });

  describe('getPendingVerificationForDiscordUser', () => {
    it('should retrieve a valid pending verification by Discord user ID', async () => {
      const discordUserId = 'discord123';
      const githubUsername = 'testuser';
      const code = 'ABC123';
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      const mockMapping = {
        githubUsername,
        discordUserId,
        verified: 0,
        verificationCode: code,
        verificationCodeExpiresAt: expiresAt,
        mappedAt: new Date(),
        mappedBy: 'self',
      };

      mockSelectResult = [mockMapping];

      const mapping = await getPendingVerificationForDiscordUser(discordUserId);
      expect(mapping).not.toBeNull();
      expect(mapping?.githubUsername).toBe(githubUsername);
      expect(mapping?.discordUserId).toBe(discordUserId);
      expect(mapping?.verificationCode).toBe(code);
    });

    it('should return null for expired verification', async () => {
      const discordUserId = 'discord123';
      const code = 'ABC123';
      const expiresAt = new Date(Date.now() - 1000); // Already expired

      const mockMapping = {
        githubUsername: 'testuser',
        discordUserId,
        verified: 0,
        verificationCode: code,
        verificationCodeExpiresAt: expiresAt,
        mappedAt: new Date(),
        mappedBy: 'self',
      };

      mockSelectResult = [mockMapping];

      const mapping = await getPendingVerificationForDiscordUser(discordUserId);
      expect(mapping).toBeNull();
    });

    it('should return null for verified mapping', async () => {
      const discordUserId = 'discord123';

      // Mock returns no results since we filter for verified = 0
      mockSelectResult = [];

      const mapping = await getPendingVerificationForDiscordUser(discordUserId);
      expect(mapping).toBeNull();
    });

    it('should return null for non-existent Discord user', async () => {
      mockSelectResult = [];

      const mapping = await getPendingVerificationForDiscordUser('nonexistent');
      expect(mapping).toBeNull();
    });
  });

  describe('markAsVerified', () => {
    it('should mark a pending verification as verified', async () => {
      const discordUserId = 'discord123';
      const githubUsername = 'testuser';

      await markAsVerified(githubUsername, discordUserId);

      expect(mockUpdateSet).toEqual({
        verified: 1,
        verificationCode: null,
        verificationCodeExpiresAt: null,
        mappedAt: expect.any(Date),
      });
    });

    it('should handle database errors gracefully', async () => {
      const mockDb = {
        update: mock(() => {
          throw new Error('Database update failed');
        }),
      };

      mock.module('./index.js', () => ({
        db: mockDb,
        userMappings: {},
      }));

      await expect(markAsVerified('testuser', 'discord123')).rejects.toThrow(
        'Failed to verify user mapping for testuser/discord123'
      );
    });
  });
});
