import { config } from './config.js';
import { error } from '../logging.js';

/**
 * Checks if a Discord user ID is in the list of admin user IDs.
 * @param discordUserId The Discord user ID to check
 * @returns true if the user is an admin, false otherwise
 */
export function isAdmin(discordUserId: string): boolean {
  try {
    const adminUserIds = config.ADMIN_DISCORD_USER_IDS;

    if (!adminUserIds || adminUserIds.trim() === '') {
      error('ADMIN_DISCORD_USER_IDS is not configured or is empty');
      return false;
    }

    const adminIdList = adminUserIds
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    if (adminIdList.length === 0) {
      error('ADMIN_DISCORD_USER_IDS contains no valid IDs');
      return false;
    }

    return adminIdList.includes(discordUserId);
  } catch (err) {
    error('Error checking admin status:', err);
    return false;
  }
}
