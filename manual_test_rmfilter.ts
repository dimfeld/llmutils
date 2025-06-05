#!/usr/bin/env bun

import { runRmfilterProgrammatically } from './src/rmfilter/rmfilter.js';
import { getGitRoot } from './src/common/git.js';

async function testRmfilter() {
  console.log('=== Manual Testing rmfilter ===');

  const gitRoot = (await getGitRoot()) || process.cwd();
  console.log('Git root:', gitRoot);

  // Test 1: Basic functionality with a simple file
  console.log('\n--- Test 1: Basic file filtering ---');
  try {
    const result1 = await runRmfilterProgrammatically(['src/logging.ts'], gitRoot, gitRoot);
    console.log('✓ Basic file filtering succeeded');
    console.log('Token count approx:', result1.length / 4);
  } catch (err) {
    console.error('✗ Basic file filtering failed:', err);
  }

  // Test 2: With glob patterns
  console.log('\n--- Test 2: Glob pattern filtering ---');
  try {
    const result2 = await runRmfilterProgrammatically(['src/common/*.ts'], gitRoot, gitRoot);
    console.log('✓ Glob pattern filtering succeeded');
    console.log('Token count approx:', result2.length / 4);
  } catch (err) {
    console.error('✗ Glob pattern filtering failed:', err);
  }

  // Test 3: With grep pattern
  console.log('\n--- Test 3: Grep pattern filtering ---');
  try {
    const result3 = await runRmfilterProgrammatically(
      ['--grep', 'export.*function', 'src/logging.ts'],
      gitRoot,
      gitRoot
    );
    console.log('✓ Grep pattern filtering succeeded');
    console.log('Token count approx:', result3.length / 4);
  } catch (err) {
    console.error('✗ Grep pattern filtering failed:', err);
  }

  // Test 4: With instructions
  console.log('\n--- Test 4: Instructions functionality ---');
  try {
    const result4 = await runRmfilterProgrammatically(
      ['--instructions', 'Add better error handling', 'src/logging.ts'],
      gitRoot,
      gitRoot
    );
    console.log('✓ Instructions functionality succeeded');
    console.log('Contains instructions:', result4.includes('Add better error handling'));
  } catch (err) {
    console.error('✗ Instructions functionality failed:', err);
  }

  // Test 5: With imports
  console.log('\n--- Test 5: With imports functionality ---');
  try {
    const result5 = await runRmfilterProgrammatically(
      ['--with-imports', 'src/rmfilter/config.ts'],
      gitRoot,
      gitRoot
    );
    console.log('✓ With imports functionality succeeded');
    console.log('Token count approx:', result5.length / 4);
  } catch (err) {
    console.error('✗ With imports functionality failed:', err);
  }

  console.log('\n=== rmfilter manual testing complete ===');
}

testRmfilter().catch(console.error);
