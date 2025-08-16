/**
 * Tests for file validation utilities
 * Critical security function tests - must be comprehensive
 */

import { beforeEach, afterEach, describe, test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateInstructionsFilePath,
  validateOutputFilePath,
  sanitizeProcessInput,
  validateDescriptionOptions,
  sanitizeTitlePrefix,
} from './file_validation.js';

describe('validateInstructionsFilePath', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rmplan-validation-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('valid paths', () => {
    test('should accept relative path within git root', () => {
      const result = validateInstructionsFilePath('instructions.txt', tempDir);
      expect(result).toBe(join(tempDir, 'instructions.txt'));
    });

    test('should accept nested relative path within git root', () => {
      const result = validateInstructionsFilePath('docs/instructions.txt', tempDir);
      expect(result).toBe(join(tempDir, 'docs/instructions.txt'));
    });

    test('should accept absolute path within git root', () => {
      const absolutePath = join(tempDir, 'instructions.txt');
      const result = validateInstructionsFilePath(absolutePath, tempDir);
      expect(result).toBe(absolutePath);
    });

    test('should accept deeply nested path within git root', () => {
      const result = validateInstructionsFilePath('a/b/c/d/instructions.txt', tempDir);
      expect(result).toBe(join(tempDir, 'a/b/c/d/instructions.txt'));
    });

    test('should handle paths with dots in filename', () => {
      const result = validateInstructionsFilePath('my.instructions.file.txt', tempDir);
      expect(result).toBe(join(tempDir, 'my.instructions.file.txt'));
    });

    test('should handle paths with spaces in filename', () => {
      const result = validateInstructionsFilePath('my instructions file.txt', tempDir);
      expect(result).toBe(join(tempDir, 'my instructions file.txt'));
    });
  });

  describe('invalid input validation', () => {
    test('should reject empty string', () => {
      expect(() => validateInstructionsFilePath('', tempDir)).toThrow(
        'Instructions file path must be a non-empty string'
      );
    });

    test('should reject null input', () => {
      expect(() => validateInstructionsFilePath(null as any, tempDir)).toThrow(
        'Instructions file path must be a non-empty string'
      );
    });

    test('should reject undefined input', () => {
      expect(() => validateInstructionsFilePath(undefined as any, tempDir)).toThrow(
        'Instructions file path must be a non-empty string'
      );
    });

    test('should reject non-string input', () => {
      expect(() => validateInstructionsFilePath(123 as any, tempDir)).toThrow(
        'Instructions file path must be a non-empty string'
      );
    });

    test('should reject array input', () => {
      expect(() => validateInstructionsFilePath(['path'] as any, tempDir)).toThrow(
        'Instructions file path must be a non-empty string'
      );
    });

    test('should reject object input', () => {
      expect(() => validateInstructionsFilePath({ path: 'test' } as any, tempDir)).toThrow(
        'Instructions file path must be a non-empty string'
      );
    });
  });

  describe('path traversal attack prevention', () => {
    test('should reject ../ path traversal', () => {
      expect(() => validateInstructionsFilePath('../instructions.txt', tempDir)).toThrow(
        'Instructions file path is outside the allowed directory'
      );
    });

    test('should reject ../../ double path traversal', () => {
      expect(() => validateInstructionsFilePath('../../instructions.txt', tempDir)).toThrow(
        'Instructions file path is outside the allowed directory'
      );
    });

    test('should reject nested path traversal', () => {
      expect(() => validateInstructionsFilePath('docs/../../../instructions.txt', tempDir)).toThrow(
        'Instructions file path is outside the allowed directory'
      );
    });

    test('should reject absolute path outside git root', () => {
      expect(() => validateInstructionsFilePath('/etc/passwd', tempDir)).toThrow(
        'Instructions file path is outside the allowed directory'
      );
    });

    test('should reject Windows-style path traversal', () => {
      expect(() => validateInstructionsFilePath('..\\instructions.txt', tempDir)).toThrow(
        'Instructions file path is outside the allowed directory'
      );
    });

    test('should reject complex path traversal with valid components', () => {
      expect(() => validateInstructionsFilePath('docs/valid/../../../etc/passwd', tempDir)).toThrow(
        'Instructions file path is outside the allowed directory'
      );
    });

    test('should reject path that resolves outside even if it looks relative', () => {
      // Create a symlink scenario that might escape
      expect(() => validateInstructionsFilePath('./../../etc/passwd', tempDir)).toThrow(
        'Instructions file path is outside the allowed directory'
      );
    });
  });

  describe('dangerous system path prevention', () => {
    test('should reject absolute /etc/ paths outside git root', () => {
      expect(() => validateInstructionsFilePath('/etc/passwd', tempDir)).toThrow(
        'Instructions file path is outside the allowed directory'
      );
    });

    test('should reject absolute /usr/ paths outside git root', () => {
      expect(() => validateInstructionsFilePath('/usr/bin/something', tempDir)).toThrow(
        'Instructions file path is outside the allowed directory'
      );
    });

    test('should reject absolute /var/log/ paths outside git root', () => {
      expect(() => validateInstructionsFilePath('/var/log/system.log', tempDir)).toThrow(
        'Instructions file path is outside the allowed directory'
      );
    });

    test('should reject absolute /home/ paths outside git root', () => {
      expect(() => validateInstructionsFilePath('/home/user/file', tempDir)).toThrow(
        'Instructions file path is outside the allowed directory'
      );
    });

    test('should reject absolute /root/ paths outside git root', () => {
      expect(() => validateInstructionsFilePath('/root/file', tempDir)).toThrow(
        'Instructions file path is outside the allowed directory'
      );
    });

    test('should accept folders named etc, usr within git root (not system paths)', () => {
      // These should be allowed because they're within the git root, not system paths
      const result = validateInstructionsFilePath('etc/passwd', tempDir);
      expect(result).toBe(join(tempDir, 'etc/passwd'));
    });

    test('should accept folders named usr within git root', () => {
      const result = validateInstructionsFilePath('usr/bin/something', tempDir);
      expect(result).toBe(join(tempDir, 'usr/bin/something'));
    });

    test('should work with non-temp git root and detect dangerous paths', () => {
      // Use a non-temp directory to test dangerous path detection
      const fakeGitRoot = '/fake/project';

      // These should fail because they try to access system paths
      expect(() => validateInstructionsFilePath('/etc/passwd', fakeGitRoot)).toThrow(
        'Instructions file path is outside the allowed directory'
      );

      expect(() => validateInstructionsFilePath('/usr/bin/test', fakeGitRoot)).toThrow(
        'Instructions file path is outside the allowed directory'
      );
    });
  });

  describe('edge cases and special characters', () => {
    test('should handle paths with special characters safely', () => {
      const result = validateInstructionsFilePath('file-with_special.chars.txt', tempDir);
      expect(result).toBe(join(tempDir, 'file-with_special.chars.txt'));
    });

    test('should handle Unicode characters in filenames', () => {
      const result = validateInstructionsFilePath('文件名.txt', tempDir);
      expect(result).toBe(join(tempDir, '文件名.txt'));
    });

    test('should reject paths with null bytes', () => {
      expect(() => validateInstructionsFilePath('file\0.txt', tempDir)).toThrow();
    });

    test('should handle current directory reference safely', () => {
      const result = validateInstructionsFilePath('./instructions.txt', tempDir);
      expect(result).toBe(join(tempDir, 'instructions.txt'));
    });

    test('should handle nested current directory references safely', () => {
      const result = validateInstructionsFilePath('./docs/./instructions.txt', tempDir);
      expect(result).toBe(join(tempDir, 'docs/instructions.txt'));
    });
  });

  describe('git root validation', () => {
    test('should work with different git root formats', () => {
      const normalizedGitRoot = tempDir.replace(/\\/g, '/');
      const result = validateInstructionsFilePath('instructions.txt', normalizedGitRoot);
      expect(result).toBe(join(normalizedGitRoot, 'instructions.txt'));
    });

    test('should handle git root with trailing slash', () => {
      const gitRootWithSlash = tempDir + '/';
      const result = validateInstructionsFilePath('instructions.txt', gitRootWithSlash);
      expect(result).toBe(join(tempDir, 'instructions.txt'));
    });

    test('should handle relative git root path', () => {
      // This shouldn't happen in real usage, but test for robustness
      const result = validateInstructionsFilePath('instructions.txt', '.');
      expect(result).toContain('instructions.txt');
    });
  });
});

describe('validateOutputFilePath', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rmplan-output-validation-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('valid paths', () => {
    test('should accept relative path within git root', () => {
      const result = validateOutputFilePath('output.txt', tempDir);
      expect(result).toBe(join(tempDir, 'output.txt'));
    });

    test('should accept nested relative path within git root', () => {
      const result = validateOutputFilePath('docs/output.txt', tempDir);
      expect(result).toBe(join(tempDir, 'docs/output.txt'));
    });

    test('should accept absolute path within git root', () => {
      const absolutePath = join(tempDir, 'output.txt');
      const result = validateOutputFilePath(absolutePath, tempDir);
      expect(result).toBe(absolutePath);
    });
  });

  describe('security validation', () => {
    test('should reject path traversal with ..', () => {
      expect(() => validateOutputFilePath('../output.txt', tempDir)).toThrow(
        'Output file path contains potentially dangerous path traversal sequence'
      );
    });

    test('should reject nested path traversal', () => {
      expect(() => validateOutputFilePath('docs/../../../output.txt', tempDir)).toThrow(
        'Output file path contains potentially dangerous path traversal sequence'
      );
    });

    test('should reject paths with null bytes', () => {
      expect(() => validateOutputFilePath('output\0.txt', tempDir)).toThrow(
        'Output file path contains null byte character'
      );
    });

    test('should reject empty string', () => {
      expect(() => validateOutputFilePath('', tempDir)).toThrow(
        'Output file path must be a non-empty string'
      );
    });

    test('should reject non-string input', () => {
      expect(() => validateOutputFilePath(123 as any, tempDir)).toThrow(
        'Output file path must be a non-empty string'
      );
    });

    test('should reject absolute path outside git root', () => {
      expect(() => validateOutputFilePath('/etc/passwd', tempDir)).toThrow(
        'Output file path is outside the allowed directory'
      );
    });

    test('should reject dangerous system paths', () => {
      expect(() => validateOutputFilePath('/var/log/test.log', tempDir)).toThrow(
        'Output file path is outside the allowed directory'
      );
    });
  });
});

describe('sanitizeProcessInput', () => {
  test('should pass through clean content unchanged', () => {
    const clean = 'This is a normal PR description\nWith multiple lines\nAnd normal characters.';
    expect(sanitizeProcessInput(clean)).toBe(clean);
  });

  test('should preserve newlines and standard whitespace', () => {
    const content = 'Line 1\nLine 2\n\nLine 4\t\tIndented';
    expect(sanitizeProcessInput(content)).toBe(content);
  });

  test('should remove null bytes', () => {
    expect(() => sanitizeProcessInput('content\0injection')).toThrow(
      'Process input contains null byte character'
    );
  });

  test('should remove control characters but preserve newlines', () => {
    const input = 'Normal text\x01\x02\x03\nSecond line\x1F';
    const expected = 'Normal text\nSecond line';
    expect(sanitizeProcessInput(input)).toBe(expected);
  });

  test('should handle Unicode content safely', () => {
    const unicode = 'PR with Unicode: 🚀 测试 💡';
    expect(sanitizeProcessInput(unicode)).toBe(unicode);
  });

  test('should reject non-string input', () => {
    expect(() => sanitizeProcessInput(123 as any)).toThrow('Process input must be a string');
    expect(() => sanitizeProcessInput(null as any)).toThrow('Process input must be a string');
    expect(() => sanitizeProcessInput(undefined as any)).toThrow('Process input must be a string');
  });

  test('should handle empty string', () => {
    expect(sanitizeProcessInput('')).toBe('');
  });

  test('should preserve markdown formatting', () => {
    const markdown = '# Title\n\n## Summary\n- Item 1\n- Item 2\n\n```code\nblock\n```';
    expect(sanitizeProcessInput(markdown)).toBe(markdown);
  });
});

describe('validateDescriptionOptions', () => {
  test('should pass valid options', () => {
    const validOptions = {
      outputFile: 'test.txt',
      copy: true,
      createPr: false,
    };
    expect(() => validateDescriptionOptions(validOptions)).not.toThrow();
  });

  test('should allow undefined options', () => {
    const options = {};
    expect(() => validateDescriptionOptions(options)).not.toThrow();
  });

  test('should reject invalid outputFile type', () => {
    const options = { outputFile: 123 };
    expect(() => validateDescriptionOptions(options)).toThrow(
      '--output-file must be a string path'
    );
  });

  test('should reject empty outputFile string', () => {
    const options = { outputFile: '' };
    expect(() => validateDescriptionOptions(options)).toThrow('--output-file cannot be empty');
  });

  test('should reject whitespace-only outputFile', () => {
    const options = { outputFile: '   ' };
    expect(() => validateDescriptionOptions(options)).toThrow('--output-file cannot be empty');
  });

  test('should reject invalid copy type', () => {
    const options = { copy: 'true' };
    expect(() => validateDescriptionOptions(options)).toThrow('--copy must be a boolean flag');
  });

  test('should reject invalid createPr type', () => {
    const options = { createPr: 1 };
    expect(() => validateDescriptionOptions(options)).toThrow('--create-pr must be a boolean flag');
  });

  test('should handle multiple invalid options', () => {
    const options = {
      outputFile: 123,
      copy: 'invalid',
      createPr: null,
    };

    // Should throw on the first validation error
    expect(() => validateDescriptionOptions(options)).toThrow();
  });

  test('should allow extra valid properties', () => {
    const options = {
      outputFile: 'test.txt',
      copy: true,
      createPr: false,
      someOtherProperty: 'value',
    };
    expect(() => validateDescriptionOptions(options)).not.toThrow();
  });
});

describe('sanitizeTitlePrefix', () => {
  test('should handle basic valid prefixes', () => {
    expect(sanitizeTitlePrefix('[Feature] ')).toBe('[Feature] ');
    expect(sanitizeTitlePrefix('WIP: ')).toBe('WIP: ');
    expect(sanitizeTitlePrefix('🚀 ')).toBe('🚀 ');
    expect(sanitizeTitlePrefix('')).toBe('');
  });

  test('should remove shell metacharacters', () => {
    expect(sanitizeTitlePrefix('[Feature] `echo test`')).toBe('[Feature] echo test');
    expect(sanitizeTitlePrefix('$USER: ')).toBe('USER: ');
    expect(sanitizeTitlePrefix('test; rm -rf /')).toBe('test rm -rf /');
    expect(sanitizeTitlePrefix('test|grep')).toBe('testgrep');
    expect(sanitizeTitlePrefix('test&background')).toBe('testbackground');
    expect(sanitizeTitlePrefix('test<input')).toBe('testinput');
    expect(sanitizeTitlePrefix('test>output')).toBe('testoutput');
    expect(sanitizeTitlePrefix('test\\escape')).toBe('testescape');
  });

  test('should remove control characters', () => {
    expect(sanitizeTitlePrefix('test\x01control')).toBe('testcontrol');
    expect(sanitizeTitlePrefix('test\x02\x1Fmore')).toBe('testmore');
    expect(sanitizeTitlePrefix('test\x7F')).toBe('test');
  });

  test('should preserve safe punctuation', () => {
    expect(sanitizeTitlePrefix('[Feature]: Bug fix - v1.0')).toBe('[Feature]: Bug fix - v1.0');
    expect(sanitizeTitlePrefix('(hotfix) @user #123')).toBe('(hotfix) @user #123');
    expect(sanitizeTitlePrefix('fix.js + test.ts')).toBe('fix.js + test.ts');
  });

  test('should limit length to 100 characters', () => {
    const longPrefix = 'a'.repeat(150);
    const result = sanitizeTitlePrefix(longPrefix);
    expect(result.length).toBe(100);
    expect(result).toBe('a'.repeat(100));
  });

  test('should trim after truncation', () => {
    const prefixWithSpaces = 'a'.repeat(98) + '   ';
    const result = sanitizeTitlePrefix(prefixWithSpaces);
    expect(result.length).toBe(98); // Trimmed length will be less than 100
    expect(result).toBe('a'.repeat(98));
  });

  test('should throw error for null bytes', () => {
    expect(() => sanitizeTitlePrefix('test\0null')).toThrow(
      'Title prefix contains null byte character'
    );
  });

  test('should throw error for non-string input', () => {
    expect(() => sanitizeTitlePrefix(123 as any)).toThrow('Title prefix must be a string');
    expect(() => sanitizeTitlePrefix(null as any)).toThrow('Title prefix must be a string');
    expect(() => sanitizeTitlePrefix(undefined as any)).toThrow('Title prefix must be a string');
  });

  test('should handle complex real-world scenarios', () => {
    // Dangerous injection attempt
    expect(sanitizeTitlePrefix('[Fix] `rm -rf /` && echo "pwned"')).toBe(
      '[Fix] rm -rf /  echo "pwned"'
    );
    
    // Mixed control characters and shell metacharacters
    expect(sanitizeTitlePrefix('test\x01`danger`\x02|pipe')).toBe('testdangerpipe');
    
    // Unicode with dangerous characters
    expect(sanitizeTitlePrefix('🚀 Feature: `$(whoami)`')).toBe('🚀 Feature: (whoami)');
  });
});
