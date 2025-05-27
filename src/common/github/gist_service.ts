import { Octokit } from 'octokit';
import { error } from '../../logging.js';

export interface GistVerificationResult {
  verified: boolean;
  message: string;
}

/**
 * Verifies a GitHub Gist contains the expected verification code from the expected user.
 *
 * @param gistUrl The URL of the Gist to verify
 * @param expectedUsername The expected GitHub username who should own the Gist
 * @param expectedCode The expected verification code that should be in the Gist
 * @returns A result object indicating if verification succeeded and a message
 */
export async function verifyGist(
  gistUrl: string,
  expectedUsername: string,
  expectedCode: string
): Promise<GistVerificationResult> {
  try {
    // Parse Gist ID from URL
    // Expected formats:
    // https://gist.github.com/username/gistid
    // https://gist.github.com/gistid
    const urlMatch = gistUrl.match(/gist\.github\.com\/(?:[^\/]+\/)?([a-f0-9]+)/i);
    if (!urlMatch) {
      return {
        verified: false,
        message: 'Invalid Gist URL format. Expected: https://gist.github.com/username/gistid',
      };
    }

    const gistId = urlMatch[1];

    // Initialize Octokit with GitHub token
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });

    // Fetch the Gist
    let gistData;
    try {
      const response = await octokit.rest.gists.get({
        gist_id: gistId,
      });
      gistData = response.data;
    } catch (err: any) {
      if (err.status === 404) {
        return {
          verified: false,
          message: 'Gist not found. Please check the URL and ensure the Gist is public.',
        };
      }
      throw err;
    }

    // Check if the Gist owner matches the expected username
    const gistOwner = gistData.owner?.login;
    if (!gistOwner) {
      return {
        verified: false,
        message: 'Could not determine Gist owner.',
      };
    }

    if (gistOwner.toLowerCase() !== expectedUsername.toLowerCase()) {
      return {
        verified: false,
        message: `Gist owner mismatch. Expected: ${expectedUsername}, Found: ${gistOwner}`,
      };
    }

    // Check if any file in the Gist contains the expected code
    const files = gistData.files;
    if (!files || Object.keys(files).length === 0) {
      return {
        verified: false,
        message: 'Gist has no files.',
      };
    }

    // Check each file for the verification code
    let foundCode = false;
    for (const file of Object.values(files)) {
      if (file && file.content && file.content.trim() === expectedCode.trim()) {
        foundCode = true;
        break;
      }
    }

    if (!foundCode) {
      return {
        verified: false,
        message:
          'Verification code not found in Gist. Please ensure the Gist contains exactly the verification code.',
      };
    }

    return {
      verified: true,
      message: 'Gist verified successfully.',
    };
  } catch (err) {
    error('Failed to verify Gist:', err);
    return {
      verified: false,
      message: `Error verifying Gist: ${(err as Error).message}`,
    };
  }
}
