// Command handler for 'tim cleanup'
// Removes end-of-line comments from changed files or specified files

import { cleanupEolComments } from '../cleanup.js';

export async function handleCleanupCommand(files: string[], options: any) {
  await cleanupEolComments(options.diffFrom, files);
}
