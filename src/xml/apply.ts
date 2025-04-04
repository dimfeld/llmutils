// from github.com/mckaywrigley/o1-xml-parser
import { promises as fs } from 'fs';
import { dirname, join } from 'path';

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
  const fullPath = join(projectDirectory, file_path);

  switch (file_operation.toUpperCase()) {
    case 'CREATE':
      if (!file_code) {
        throw new Error(`No file_code provided for CREATE operation on ${file_path}`);
      }
      console.log(`Writing to ${fullPath}`);
      if (!dryRun) {
        await ensureDirectoryExists(dirname(fullPath));
        await fs.writeFile(fullPath, file_code, 'utf-8');
      }
      break;

    case 'UPDATE':
      if (!file_code) {
        throw new Error(`No file_code provided for UPDATE operation on ${file_path}`);
      }
      console.log(`Writing to ${fullPath}`);
      if (!dryRun) {
        await ensureDirectoryExists(dirname(fullPath));
        await fs.writeFile(fullPath, file_code, 'utf-8');
      }
      break;

    case 'DELETE':
      console.log(`Deleting ${fullPath}`);
      if (!dryRun) {
        await fs.rm(fullPath, { force: true });
      }
      break;

    default:
      console.warn(`Unknown file_operation: ${file_operation} for file: ${file_path}`);
      break;
  }
}

async function ensureDirectoryExists(dir: string) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error: any) {
    if (error.code !== 'EEXIST') {
      console.error(`Error creating directory ${dir}:`, error);
      throw error;
    }
  }
}
