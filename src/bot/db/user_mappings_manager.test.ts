import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  mapUser,
  getUserMappingByGithubUsername,
  getUserMappingByDiscordId,
} from './user_mappings_manager.js';
import * as dbModule from './index.js';

// Mock the database module
mock.module('./index.js', () => {
  const mockDb = {
    insert: mock(() => ({
      values: mock(() => ({
        onConflictDoUpdate: mock(() => Promise.resolve()),
      })),
    })),
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(() => Promise.resolve([])),
        })),
      })),
    })),
  };

  return {
    db: mockDb,
    userMappings: {},
  };
});

describe('user_mappings_manager', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  describe('mapUser', () => {
    test('should map a user successfully', async () => {
      const mockInsert = mock(() => ({
        values: mock(() => ({
          onConflictDoUpdate: mock(() => Promise.resolve()),
        })),
      }));

      const mockDb = {
        insert: mockInsert,
      };

      mock.module('./index.js', () => ({
        db: mockDb,
        userMappings: {},
      }));

      await mapUser('testuser', 'discord123', 'admin', true);

      expect(mockInsert).toHaveBeenCalledTimes(1);
    });

    test('should handle database errors gracefully', async () => {
      const mockDb = {
        insert: mock(() => {
          throw new Error('Database connection failed');
        }),
      };

      mock.module('./index.js', () => ({
        db: mockDb,
        userMappings: {},
      }));

      await expect(mapUser('testuser', 'discord123', 'admin', true)).rejects.toThrow(
        'Failed to map user testuser to Discord ID discord123'
      );
    });
  });

  describe('getUserMappingByGithubUsername', () => {
    test('should return user mapping when found', async () => {
      const mockUserMapping = {
        githubUsername: 'testuser',
        discordUserId: 'discord123',
        verified: 1,
        mappedAt: new Date('2024-01-01'),
        mappedBy: 'admin',
      };

      const mockDb = {
        select: mock(() => ({
          from: mock(() => ({
            where: mock(() => ({
              limit: mock(() => Promise.resolve([mockUserMapping])),
            })),
          })),
        })),
      };

      mock.module('./index.js', () => ({
        db: mockDb,
        userMappings: {},
      }));

      const result = await getUserMappingByGithubUsername('testuser');

      expect(result).toEqual(mockUserMapping);
    });

    test('should return null when user not found', async () => {
      const mockDb = {
        select: mock(() => ({
          from: mock(() => ({
            where: mock(() => ({
              limit: mock(() => Promise.resolve([])),
            })),
          })),
        })),
      };

      mock.module('./index.js', () => ({
        db: mockDb,
        userMappings: {},
      }));

      const result = await getUserMappingByGithubUsername('nonexistent');

      expect(result).toBeNull();
    });

    test('should handle database errors gracefully', async () => {
      const mockDb = {
        select: mock(() => {
          throw new Error('Database query failed');
        }),
      };

      mock.module('./index.js', () => ({
        db: mockDb,
        userMappings: {},
      }));

      await expect(getUserMappingByGithubUsername('testuser')).rejects.toThrow(
        'Failed to retrieve user mapping for GitHub username testuser'
      );
    });
  });

  describe('getUserMappingByDiscordId', () => {
    test('should return user mapping when found', async () => {
      const mockUserMapping = {
        githubUsername: 'testuser',
        discordUserId: 'discord123',
        verified: 1,
        mappedAt: new Date('2024-01-01'),
        mappedBy: 'self',
      };

      const mockDb = {
        select: mock(() => ({
          from: mock(() => ({
            where: mock(() => ({
              limit: mock(() => Promise.resolve([mockUserMapping])),
            })),
          })),
        })),
      };

      mock.module('./index.js', () => ({
        db: mockDb,
        userMappings: {},
      }));

      const result = await getUserMappingByDiscordId('discord123');

      expect(result).toEqual(mockUserMapping);
    });

    test('should return null when user not found', async () => {
      const mockDb = {
        select: mock(() => ({
          from: mock(() => ({
            where: mock(() => ({
              limit: mock(() => Promise.resolve([])),
            })),
          })),
        })),
      };

      mock.module('./index.js', () => ({
        db: mockDb,
        userMappings: {},
      }));

      const result = await getUserMappingByDiscordId('nonexistent');

      expect(result).toBeNull();
    });

    test('should handle database errors gracefully', async () => {
      const mockDb = {
        select: mock(() => {
          throw new Error('Database query failed');
        }),
      };

      mock.module('./index.js', () => ({
        db: mockDb,
        userMappings: {},
      }));

      await expect(getUserMappingByDiscordId('discord123')).rejects.toThrow(
        'Failed to retrieve user mapping for Discord ID discord123'
      );
    });
  });
});
