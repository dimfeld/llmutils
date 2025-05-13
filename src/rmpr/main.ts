import { error, log } from '../logging.js';
import type { PrIdentifier } from './types.js';

export function parsePrIdentifier(identifier: string): PrIdentifier | null {
  // Try parsing as full URL: https://github.com/owner/repo/pull/123
  const urlMatch = identifier.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)$/);
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      prNumber: parseInt(urlMatch[3], 10),
    };
  }

  // Try parsing as short format: owner/repo#123
  const shortMatch = identifier.match(/^([^\/]+)\/([^\/#]+)#(\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1],
      repo: shortMatch[2],
      prNumber: parseInt(shortMatch[3], 10),
    };
  }

  // Try parsing as alternative short format: owner/repo/123
  const altShortMatch = identifier.match(/^([^\/]+)\/([^\/]+)\/(\d+)$/);
  if (altShortMatch) {
    return {
      owner: altShortMatch[1],
      repo: altShortMatch[2],
      prNumber: parseInt(altShortMatch[3], 10),
    };
  }

  return null;
}

export async function handleRmprCommand(prIdentifierArg: string, options: any, globalCliOptions: any) {
  const parsedIdentifier = parsePrIdentifier(prIdentifierArg);

  if (!parsedIdentifier) {
    error(`Invalid PR identifier format: ${prIdentifierArg}. Expected URL (e.g., https://github.com/owner/repo/pull/123), owner/repo#123, or owner/repo/123.`);
    process.exit(1);
  }

  log(`Parsed PR Identifier:
  Owner: ${parsedIdentifier.owner}
  Repo: ${parsedIdentifier.repo}
  PR Number: ${parsedIdentifier.prNumber}
  Mode: ${options.mode}
  Yes: ${options.yes}
  Model: ${options.model || 'default/not specified'}
  Debug: ${globalCliOptions.debug || false}`);

  // Further implementation will go here
}
