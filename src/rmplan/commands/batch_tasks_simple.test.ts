import { describe, test, expect } from 'bun:test';
import { $ } from 'bun';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('--batch-tasks flag simple smoke tests', () => {
  test('--batch-tasks flag is recognized and does not cause CLI errors', async () => {
    // Create a temporary directory for this test
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-smoke-test-'));
    const rmplanPath = path.join(process.cwd(), 'src/rmplan/rmplan.ts');
    
    try {
      // Test that the flag is recognized by checking help output
      const helpResult = await $`bun ${rmplanPath} agent --help`.nothrow();
      expect(helpResult.exitCode).toBe(0);
      
      const helpOutput = helpResult.stdout.toString();
      expect(helpOutput).toContain('--batch-tasks');
      expect(helpOutput).toContain('Enable batch task execution mode');
      
      // Test that the flag doesn't cause parsing errors when used
      const flagResult = await $`bun ${rmplanPath} agent --batch-tasks --help`.nothrow();
      expect(flagResult.exitCode).toBe(0);
      
      // Should not contain any error messages about unknown options
      const flagOutput = flagResult.stdout.toString() + flagResult.stderr.toString();
      expect(flagOutput).not.toContain('unknown option');
      expect(flagOutput).not.toContain('error:');
    } finally {
      // Clean up
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('run command alias also supports --batch-tasks', async () => {
    const rmplanPath = path.join(process.cwd(), 'src/rmplan/rmplan.ts');
    
    // Test that the flag works with the 'run' alias as well
    const result = await $`bun ${rmplanPath} run --help`.nothrow();
    expect(result.exitCode).toBe(0);
    
    const output = result.stdout.toString();
    expect(output).toContain('--batch-tasks');
    expect(output).toContain('Enable batch task execution mode');
  });
});