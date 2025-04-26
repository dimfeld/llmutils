// originally from github.com/mckaywrigley/o1-xml-parser
import * as path from 'path';
import { secureWrite, secureRm } from '../../rmfilter/utils.js';

export interface FileChange {
  file_summary: string;
  file_operation: string;
  file_path: string;
  file_code?: string;
}

export async function applyFileChanges(
  change: FileChange,
  projectDirectory: string,
  dryRun: boolean = false
) {
  const { file_operation, file_path, file_code } = change;
  // file_path should be relative to projectDirectory

  // Basic validation: Ensure it's not absolute and doesn't try to escape the root.
  if (path.isAbsolute(file_path) || file_path.startsWith('..')) {
    throw new Error(
      `Security Error: Invalid file path detected: ${file_path}. Path must be relative within the project.`
    );
  }

  switch (file_operation.toUpperCase()) {
    case 'CREATE':
    case 'UPDATE': // Combine CREATE and UPDATE logic
      if (!file_code) {
        throw new Error(`No file_code provided for ${file_operation} operation on ${file_path}`);
      }
      console.log(`${dryRun ? '[Dry Run] Would write' : 'Writing'} to ${file_path}`);
      if (!dryRun) {
        await secureWrite(projectDirectory, file_path, file_code);
      }
      break;

    case 'DELETE':
      console.log(`${dryRun ? '[Dry Run] Would delete' : 'Deleting'} ${file_path}`);
      if (!dryRun) {
        await secureRm(projectDirectory, file_path);
      }
      break;

    default:
      console.warn(`Warning: Unknown file_operation "${file_operation}" for file: ${file_path}`);
      break;
  }
}
