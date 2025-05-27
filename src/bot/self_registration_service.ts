import { log, error } from '../logging.js';
import { verifyGist } from '../common/github/gist_service.js';
import {
  getPendingVerificationForDiscordUser,
  markAsVerified,
} from './db/user_mappings_manager.js';

export interface RegistrationResult {
  success: boolean;
  message: string;
}

/**
 * Completes the self-registration process by verifying a Gist and marking the user as verified.
 *
 * @param discordUserId The Discord user ID attempting to complete registration
 * @param gistUrl The URL of the Gist containing the verification code
 * @returns A result object indicating success/failure and a message
 */
export async function completeRegistration(
  discordUserId: string,
  gistUrl: string
): Promise<RegistrationResult> {
  try {
    // Retrieve pending verification for this Discord user
    const pendingVerification = await getPendingVerificationForDiscordUser(discordUserId);

    if (!pendingVerification) {
      return {
        success: false,
        message:
          'No pending verification found for your account. Please start the registration process with `/rm-register`.',
      };
    }

    if (!pendingVerification.verificationCode) {
      return {
        success: false,
        message: 'Invalid verification state. Please restart the registration process.',
      };
    }

    // Verify the Gist
    const gistResult = await verifyGist(
      gistUrl,
      pendingVerification.githubUsername,
      pendingVerification.verificationCode
    );

    if (!gistResult.verified) {
      return {
        success: false,
        message: `Verification failed: ${gistResult.message}`,
      };
    }

    // Mark the user as verified
    await markAsVerified(pendingVerification.githubUsername, discordUserId);

    log(
      `User ${discordUserId} successfully verified as GitHub user ${pendingVerification.githubUsername} via Gist`
    );

    return {
      success: true,
      message: `GitHub account @${pendingVerification.githubUsername} successfully linked and verified!`,
    };
  } catch (err) {
    error(`Failed to complete registration for Discord user ${discordUserId}:`, err);
    return {
      success: false,
      message: `Error during registration: ${(err as Error).message}`,
    };
  }
}
