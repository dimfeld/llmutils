#!/usr/bin/env bun
import { extractMarkdownToYaml } from './src/rmplan/actions.js';
import { getDefaultConfig } from './src/rmplan/configSchema.js';

const testYaml = `
goal: Implement a new feature
details: This is a test plan
tasks:
  - title: Test Task
    description: A test task
    files:
      - src/test.ts
    steps:
      - prompt: Do something
`;

async function test() {
  const config = getDefaultConfig();

  // Test with all options
  console.log('Full YAML output with metadata:');
  const result = await extractMarkdownToYaml(testYaml, config, true, {
    issueUrls: [
      'https://github.com/owner/repo/issues/123',
      'https://github.com/owner/repo/issues/456',
    ],
    planRmfilterArgs: ['--with-imports', '--', 'src/**/*.ts', '--', 'tests/**/*.ts'],
  });

  console.log(result);
}

test().catch(console.error);
