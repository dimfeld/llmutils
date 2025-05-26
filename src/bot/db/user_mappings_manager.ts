import { eq } from 'drizzle-orm';
import { db, userMappings } from './index.js';
import { error } from '../../logging.js';

export interface UserMapping {
  githubUsername: string;
  discordUserId: string | null;
  verified: number | null;
  mappedAt: Date | null;
  mappedBy: string | null;
}

/**
 * Maps a GitHub username to a Discord user ID.
 * Performs an upsert operation on the user_mappings table.
 *
 * @param githubUsername The GitHub username to map
 * @param discordUserId The Discord user ID to map to
 * @param mappedBy Who is creating this mapping ('admin' or 'self')
 * @param verified Whether the mapping is verified
 * @returns Promise that resolves when the mapping is complete
 */
export async function mapUser(
  githubUsername: string,
  discordUserId: string,
  mappedBy: 'admin' | 'self',
  verified: boolean
): Promise<void> {
  try {
    await db
      .insert(userMappings)
      .values({
        githubUsername,
        discordUserId,
        verified: verified ? 1 : 0,
        mappedBy,
        mappedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userMappings.githubUsername,
        set: {
          discordUserId,
          verified: verified ? 1 : 0,
          mappedBy,
          mappedAt: new Date(),
        },
      });
  } catch (err) {
    error('Failed to map user:', err);
    throw new Error(`Failed to map user ${githubUsername} to Discord ID ${discordUserId}`);
  }
}

/**
 * Retrieves a user mapping by GitHub username.
 *
 * @param githubUsername The GitHub username to look up
 * @returns The user mapping if found, null otherwise
 */
export async function getUserMappingByGithubUsername(
  githubUsername: string
): Promise<UserMapping | null> {
  try {
    const result = await db
      .select({
        githubUsername: userMappings.githubUsername,
        discordUserId: userMappings.discordUserId,
        verified: userMappings.verified,
        mappedAt: userMappings.mappedAt,
        mappedBy: userMappings.mappedBy,
      })
      .from(userMappings)
      .where(eq(userMappings.githubUsername, githubUsername))
      .limit(1);

    return result.length > 0 ? result[0] : null;
  } catch (err) {
    error('Failed to get user mapping by GitHub username:', err);
    throw new Error(`Failed to retrieve user mapping for GitHub username ${githubUsername}`);
  }
}

/**
 * Retrieves a user mapping by Discord ID.
 *
 * @param discordUserId The Discord user ID to look up
 * @returns The user mapping if found, null otherwise
 */
export async function getUserMappingByDiscordId(
  discordUserId: string
): Promise<UserMapping | null> {
  try {
    const result = await db
      .select({
        githubUsername: userMappings.githubUsername,
        discordUserId: userMappings.discordUserId,
        verified: userMappings.verified,
        mappedAt: userMappings.mappedAt,
        mappedBy: userMappings.mappedBy,
      })
      .from(userMappings)
      .where(eq(userMappings.discordUserId, discordUserId))
      .limit(1);

    return result.length > 0 ? result[0] : null;
  } catch (err) {
    error('Failed to get user mapping by Discord ID:', err);
    throw new Error(`Failed to retrieve user mapping for Discord ID ${discordUserId}`);
  }
}
