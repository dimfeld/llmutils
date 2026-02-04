import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Opens an editor for the user to input markdown text
 * @param prompt - Optional prompt to display as a comment at the top of the file
 * @returns The user's input with comment lines removed
 */
export async function openEditorForInput(prompt?: string): Promise<string> {
  const editor = process.env.EDITOR || 'nano';

  // Create temporary file
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-'));
  const tempPath = path.join(tempDir, 'details.md');

  // Write prompt as comment if provided
  if (prompt) {
    await fs.writeFile(tempPath, `# ${prompt}\n\n`);
  } else {
    await fs.writeFile(tempPath, '');
  }

  // Open editor
  const editorProcess = Bun.spawn([editor, tempPath], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  await editorProcess.exited;

  // Read result
  const content = await fs.readFile(tempPath, 'utf-8');

  // Clean up
  await fs.rm(tempDir, { recursive: true });

  // Remove comment lines and trim
  return content
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim();
}

/**
 * Reads input from stdin
 * @returns The complete stdin input as a string
 */
export async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}
