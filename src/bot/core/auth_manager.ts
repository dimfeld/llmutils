import { Octokit } from 'octokit';
import { config as botConfig } from '../config.js';
import { log, warn } from '../../logging.js';

let octokit: Octokit;

function getOctokit() {
  if (!octokit) {
    octokit = new Octokit({ auth: botConfig.GITHUB_TOKEN });
  }
  return octokit;
}

export async function canUserPerformAction(
  githubUsername: string,
  repoFullName: string // "owner/repo"
): Promise<boolean> {
  if (!botConfig.GITHUB_TOKEN) {
    warn(
      'GITHUB_TOKEN is not set. Permission checks will be skipped, and all actions will be allowed. THIS IS INSECURE.'
    );
    return true; // Or false, to be safe if token is missing. Let's be permissive for now if no token.
  }

  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) {
    log(`Invalid repository name for permission check: ${repoFullName}`);
    return false; // Cannot check permissions without owner/repo
  }

  try {
    const { data: permissions } = await getOctokit().rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: githubUsername,
    });

    log(`User ${githubUsername} permission level for ${repoFullName}: ${permissions.permission}`);
    // Allowed permissions: 'admin', 'write'
    return ['admin', 'write'].includes(permissions.permission);
  } catch (error: any) {
    // If user is not a collaborator, API returns 404.
    // If user has no explicit permissions but repo is public & allows issue creation by anyone, this check might be too strict.
    // However, for @bot commands that trigger actions, restricting to collaborators with write/admin is safer.
    if (error.status === 404) {
      log(
        `User ${githubUsername} is not a collaborator or has no explicit permissions on ${repoFullName}.`
      );
    } else {
      warn(
        `Failed to get permission level for ${githubUsername} on ${repoFullName}: ${error.message}`
      );
    }
    return false;
  }
}
