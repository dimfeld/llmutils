import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { validatePath, secureWrite, secureRm } from './fs';

describe('validatePath', () => {
  const baseDir = '/home/user/project';

  it('should return absolute path for valid relative path within base directory', () => {
    const relativePath = 'src/file.txt';
    const expected = path.resolve(baseDir, relativePath);
    const result = validatePath(baseDir, relativePath);
    expect(result).toBe(expected);
  });

  it('should allow operations on the base directory itself', () => {
    const relativePath = '.';
    const expected = path.resolve(baseDir);
    const result = validatePath(baseDir, relativePath);
    expect(result).toBe(expected);
  });

  it('should handle nested paths correctly', () => {
    const relativePath = 'src/nested/deep/file.txt';
    const expected = path.resolve(baseDir, relativePath);
    const result = validatePath(baseDir, relativePath);
    expect(result).toBe(expected);
  });

  it('should throw error for path traversal attempts', () => {
    const relativePath = '../outside.txt';
    expect(() => validatePath(baseDir, relativePath)).toThrow(
      `Security Error: Attempted file operation outside of the base directory "${path.resolve(baseDir)}"`
    );
  });

  it('should throw error for absolute path outside base directory', () => {
    const relativePath = '/home/other/file.txt';
    expect(() => validatePath(baseDir, relativePath)).toThrow(
      `Security Error: Attempted file operation outside of the base directory "${path.resolve(baseDir)}"`
    );
  });

  it('should handle complex path with dot and dot-dot', () => {
    const relativePath = 'src/./nested/../file.txt';
    const expected = path.resolve(baseDir, 'src/file.txt');
    const result = validatePath(baseDir, relativePath);
    expect(result).toBe(expected);
  });

  it('should throw error for path attempting to escape with multiple dot-dot', () => {
    const relativePath = '../../../etc/passwd';
    expect(() => validatePath(baseDir, relativePath)).toThrow(
      `Security Error: Attempted file operation outside of the base directory "${path.resolve(baseDir)}"`
    );
  });
});

describe('secureWrite', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-secure-write-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should write content to a valid path within base directory', async () => {
    const relativePath = 'test.txt';
    const content = 'Hello, world!';

    await secureWrite(tempDir, relativePath, content);

    const writtenContent = await fs.readFile(path.join(tempDir, relativePath), 'utf-8');
    expect(writtenContent).toBe(content);
  });

  it('should write content to nested directories within base directory', async () => {
    const relativePath = 'nested/deep/test.txt';
    const content = 'Nested content';

    // Create the nested directories first
    await fs.mkdir(path.join(tempDir, 'nested', 'deep'), { recursive: true });

    await secureWrite(tempDir, relativePath, content);

    const writtenContent = await fs.readFile(path.join(tempDir, relativePath), 'utf-8');
    expect(writtenContent).toBe(content);
  });

  it('should write Buffer content correctly', async () => {
    const relativePath = 'binary.txt';
    const content = Buffer.from('Binary content', 'utf-8');

    await secureWrite(tempDir, relativePath, content);

    const writtenContent = await fs.readFile(path.join(tempDir, relativePath));
    expect(writtenContent.equals(content)).toBe(true);
  });

  it('should throw error for path traversal attempts', async () => {
    const relativePath = '../outside.txt';
    const content = 'Malicious content';

    await expect(secureWrite(tempDir, relativePath, content)).rejects.toThrow(
      'Security Error: Attempted file operation outside of the base directory'
    );
  });

  it('should overwrite existing files', async () => {
    const relativePath = 'existing.txt';
    const originalContent = 'Original content';
    const newContent = 'New content';

    // First write
    await secureWrite(tempDir, relativePath, originalContent);
    let writtenContent = await fs.readFile(path.join(tempDir, relativePath), 'utf-8');
    expect(writtenContent).toBe(originalContent);

    // Overwrite
    await secureWrite(tempDir, relativePath, newContent);
    writtenContent = await fs.readFile(path.join(tempDir, relativePath), 'utf-8');
    expect(writtenContent).toBe(newContent);
  });
});

describe('secureRm', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-secure-rm-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should remove a file within base directory', async () => {
    const relativePath = 'test.txt';
    const content = 'Test content';

    // Create the file first
    await secureWrite(tempDir, relativePath, content);
    expect(
      await fs
        .access(path.join(tempDir, relativePath))
        .then(() => true)
        .catch(() => false)
    ).toBe(true);

    // Remove it
    await secureRm(tempDir, relativePath);
    expect(
      await fs
        .access(path.join(tempDir, relativePath))
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });

  it('should not throw error when removing non-existent file', async () => {
    const relativePath = 'nonexistent.txt';

    // Should not throw an error (force: true behavior)
    await expect(secureRm(tempDir, relativePath)).resolves.toBeUndefined();
  });

  it('should remove nested files within base directory', async () => {
    const relativePath = 'nested/test.txt';
    const content = 'Nested content';

    // Create nested directory and file
    await fs.mkdir(path.join(tempDir, 'nested'), { recursive: true });
    await secureWrite(tempDir, relativePath, content);
    expect(
      await fs
        .access(path.join(tempDir, relativePath))
        .then(() => true)
        .catch(() => false)
    ).toBe(true);

    // Remove the file
    await secureRm(tempDir, relativePath);
    expect(
      await fs
        .access(path.join(tempDir, relativePath))
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });

  it('should throw error for path traversal attempts', async () => {
    const relativePath = '../outside.txt';

    await expect(secureRm(tempDir, relativePath)).rejects.toThrow(
      'Security Error: Attempted file operation outside of the base directory'
    );
  });

  it('should use validatePath correctly', async () => {
    const relativePath = 'src/./nested/../file.txt';
    const normalizedPath = 'src/file.txt';
    const content = 'Test content';

    // Create the file using the normalized path
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await secureWrite(tempDir, normalizedPath, content);
    expect(
      await fs
        .access(path.join(tempDir, normalizedPath))
        .then(() => true)
        .catch(() => false)
    ).toBe(true);

    // Remove using the complex path that should resolve to the same file
    await secureRm(tempDir, relativePath);
    expect(
      await fs
        .access(path.join(tempDir, normalizedPath))
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });
});
