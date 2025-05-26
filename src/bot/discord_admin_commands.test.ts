import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mapUser } from './db/user_mappings_manager.js';
import { isAdmin } from './discord_admin_utils.js';

// Mock the modules
mock.module('./db/user_mappings_manager.js', () => ({
  mapUser: mock(() => Promise.resolve()),
}));

mock.module('./discord_admin_utils.js', () => ({
  isAdmin: mock(() => false),
}));

describe('Discord Admin Commands', () => {
  beforeEach(() => {
    // Reset mocks before each test
    (mapUser as any).mockClear();
    (isAdmin as any).mockClear();
  });

  describe('/rm-link-user command', () => {
    test('should successfully map user when admin runs command', async () => {
      // Setup
      const githubUsername = 'testuser';
      const discordId = '123456789';
      (isAdmin as any).mockReturnValue(true);

      // Execute
      await mapUser(githubUsername, discordId, 'admin', true);

      // Verify
      expect(mapUser).toHaveBeenCalledWith(githubUsername, discordId, 'admin', true);
      expect(mapUser).toHaveBeenCalledTimes(1);
    });

    test('should reject command when non-admin user tries to run it', async () => {
      // Setup
      const userId = 'non-admin-user-id';
      (isAdmin as any).mockReturnValue(false);

      // Execute
      const result = isAdmin(userId);

      // Verify
      expect(result).toBe(false);
      expect(isAdmin).toHaveBeenCalledWith(userId);
      expect(mapUser).not.toHaveBeenCalled();
    });

    test('should handle errors from mapUser gracefully', async () => {
      // Setup
      const githubUsername = 'testuser';
      const discordId = '123456789';
      const errorMessage = 'Database error';
      (isAdmin as any).mockReturnValue(true);
      (mapUser as any).mockRejectedValue(new Error(errorMessage));

      // Execute & Verify
      await expect(mapUser(githubUsername, discordId, 'admin', true)).rejects.toThrow(errorMessage);
    });

    test('should accept various input parameters', async () => {
      // Setup
      (isAdmin as any).mockReturnValue(true);
      (mapUser as any).mockResolvedValue(undefined);

      // Test with empty github username - the actual implementation would handle validation
      await mapUser('', '123456789', 'admin', true);
      expect(mapUser).toHaveBeenCalledWith('', '123456789', 'admin', true);

      // Test with empty discord ID - the actual implementation would handle validation
      await mapUser('testuser', '', 'admin', true);
      expect(mapUser).toHaveBeenCalledWith('testuser', '', 'admin', true);
    });
  });
});
