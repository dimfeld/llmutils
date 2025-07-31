#!/usr/bin/env bun

// Quick manual test of the parseRmCommand implementation
import { ClaudeCodeExecutor } from './src/rmplan/executors/claude_code.ts';

const mockSharedOptions = {
  baseDir: '/test/base',
  model: 'claude-3-opus-20240229',
  interactive: false,
};

const mockConfig = {};

const executor = new ClaudeCodeExecutor(
  {
    allowedTools: [],
    disallowedTools: [],
    allowAllTools: false,
    permissionsMcp: { enabled: false },
  },
  mockSharedOptions as any,
  mockConfig as any
);

// Access the private method for testing
const parseRmCommand = (executor as any).parseRmCommand.bind(executor);

console.log('Testing parseRmCommand implementation:');
console.log('=====================================');

const testCases = [
  'rm file.txt',
  'rm -f file.txt',
  'rm -rf directory',
  'rm file1.txt file2.txt',
  'rm "file with spaces.txt"',
  "rm 'another file.txt'",
  'rm *.txt',
  'rm --force file.txt',
  'rm -rf',
  'ls -la',
  'rmdir directory',
];

for (const testCase of testCases) {
  const result = parseRmCommand(testCase);
  console.log(`"${testCase}" -> [${result.map(p => `"${p}"`).join(', ')}]`);
}

console.log('\nDone!');