// Command handler for 'rmplan cleanup'
// Removes end-of-line comments from changed files or specified files

import { error } from '../../logging.js';
import { cleanupEolComments } from '../cleanup.js';

export async function handleCleanupCommand(files: string[], options: any) {
  try {
    await cleanupEolComments(options.diffFrom, files);
  } catch (err) {
    error('Failed to cleanup comments:', err);
    process.exit(1);
  }
}
