import { eq, and, lt, isNull } from 'drizzle-orm';
import { db, userMappings } from './index.js';
import { error } from '../../logging.js';

export interface UserMapping {
  githubUsername: string;
  discordUserId: string | null;
  verified: number | null;
  verificationCode: string | null;
  verificationCodeExpiresAt: Date | null;
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
        verificationCode: userMappings.verificationCode,
        verificationCodeExpiresAt: userMappings.verificationCodeExpiresAt,
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
        verificationCode: userMappings.verificationCode,
        verificationCodeExpiresAt: userMappings.verificationCodeExpiresAt,
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

/**
 * Stores a pending verification for a user mapping.
 * Creates or updates a user mapping with a verification code.
 *
 * @param discordUserId The Discord user ID
 * @param githubUsername The GitHub username to verify
 * @param code The verification code
 * @param expiresAt When the verification code expires
 * @returns Promise that resolves when the operation is complete
 * @throws Error if the GitHub username is already verified for a different Discord user
 */
export async function upsertPendingVerification(
  discordUserId: string,
  githubUsername: string,
  code: string,
  expiresAt: Date
): Promise<void> {
  try {
    // Check if this GitHub username is already verified for a different Discord user
    const existing = await getUserMappingByGithubUsername(githubUsername);
    if (existing && existing.verified && existing.discordUserId !== discordUserId) {
      throw new Error(
        `GitHub username ${githubUsername} is already verified for a different Discord user`
      );
    }

    await db
      .insert(userMappings)
      .values({
        githubUsername,
        discordUserId,
        verified: 0,
        verificationCode: code,
        verificationCodeExpiresAt: expiresAt,
        mappedBy: 'self',
        mappedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userMappings.githubUsername,
        set: {
          discordUserId,
          verified: 0,
          verificationCode: code,
          verificationCodeExpiresAt: expiresAt,
          mappedBy: 'self',
          mappedAt: new Date(),
        },
      });
  } catch (err) {
    if (err instanceof Error && err.message.includes('already verified')) {
      throw err;
    }
    error('Failed to upsert pending verification:', err);
    throw new Error(`Failed to store pending verification for ${githubUsername}`);
  }
}

/**
 * Retrieves a pending verification by GitHub username and Discord ID.
 *
 * @param githubUsername The GitHub username
 * @param discordUserId The Discord user ID
 * @returns The user mapping if found and not expired, null otherwise
 */
export async function getPendingVerification(
  githubUsername: string,
  discordUserId: string
): Promise<UserMapping | null> {
  try {
    const result = await db
      .select({
        githubUsername: userMappings.githubUsername,
        discordUserId: userMappings.discordUserId,
        verified: userMappings.verified,
        verificationCode: userMappings.verificationCode,
        verificationCodeExpiresAt: userMappings.verificationCodeExpiresAt,
        mappedAt: userMappings.mappedAt,
        mappedBy: userMappings.mappedBy,
      })
      .from(userMappings)
      .where(
        and(
          eq(userMappings.githubUsername, githubUsername),
          eq(userMappings.discordUserId, discordUserId),
          eq(userMappings.verified, 0)
        )
      )
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    const mapping = result[0];
    // Check if expired
    if (mapping.verificationCodeExpiresAt && mapping.verificationCodeExpiresAt < new Date()) {
      return null;
    }

    return mapping;
  } catch (err) {
    error('Failed to get pending verification:', err);
    throw new Error(
      `Failed to retrieve pending verification for ${githubUsername}/${discordUserId}`
    );
  }
}

/**
 * Retrieves a pending verification by verification code.
 *
 * @param code The verification code to look up
 * @returns The user mapping if found, not expired, and not verified, null otherwise
 */
export async function getPendingVerificationByCode(code: string): Promise<UserMapping | null> {
  try {
    const now = new Date();
    const result = await db
      .select({
        githubUsername: userMappings.githubUsername,
        discordUserId: userMappings.discordUserId,
        verified: userMappings.verified,
        verificationCode: userMappings.verificationCode,
        verificationCodeExpiresAt: userMappings.verificationCodeExpiresAt,
        mappedAt: userMappings.mappedAt,
        mappedBy: userMappings.mappedBy,
      })
      .from(userMappings)
      .where(and(eq(userMappings.verificationCode, code), eq(userMappings.verified, 0)))
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    const mapping = result[0];
    // Check if expired
    if (mapping.verificationCodeExpiresAt && mapping.verificationCodeExpiresAt < now) {
      return null;
    }

    return mapping;
  } catch (err) {
    error('Failed to get pending verification by code:', err);
    throw new Error('Failed to retrieve pending verification by code');
  }
}

/**
 * Marks a user mapping as verified, clearing the verification code.
 *
 * @param githubUsername The GitHub username
 * @param discordUserId The Discord user ID
 * @returns Promise that resolves when the operation is complete
 */
export async function markAsVerified(githubUsername: string, discordUserId: string): Promise<void> {
  try {
    await db
      .update(userMappings)
      .set({
        verified: 1,
        verificationCode: null,
        verificationCodeExpiresAt: null,
        mappedAt: new Date(),
      })
      .where(
        and(
          eq(userMappings.githubUsername, githubUsername),
          eq(userMappings.discordUserId, discordUserId)
        )
      );
  } catch (err) {
    error('Failed to mark user mapping as verified:', err);
    throw new Error(`Failed to verify user mapping for ${githubUsername}/${discordUserId}`);
  }
}
