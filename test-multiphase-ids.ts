#!/usr/bin/env bun

import { saveMultiPhaseYaml } from './src/rmplan/process_markdown.js';
import type { ExtractMarkdownToYamlOptions } from './src/rmplan/process_markdown.js';
import { getDefaultConfig } from './src/rmplan/configSchema.js';
import { clearPlanCache } from './src/rmplan/plans.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Create a test directory
const testDir = await fs.mkdtemp('test-multiphase-');
console.log(`Test directory: ${testDir}`);

// Create some existing plan files to simulate existing numeric IDs
await fs.writeFile(path.join(testDir, '1.yml'), `id: 1
goal: Test plan 1
tasks: []
`);
await fs.writeFile(path.join(testDir, '2.yml'), `id: 2
goal: Test plan 2
tasks: []
`);
await fs.writeFile(path.join(testDir, '5.yml'), `id: 5
goal: Test plan 5
tasks: []
`);

// Test multi-phase YAML
const testYaml = {
  title: 'Test Multi-Phase Project',
  goal: 'Test sequential numeric ID generation',
  details: 'This is a test project',
  phases: [
    {
      goal: 'Phase 1 - Setup',
      details: 'Setup phase',
      tasks: [{
        title: 'Setup project',
        description: 'Initialize the project structure',
        steps: []
      }]
    },
    {
      goal: 'Phase 2 - Implementation',
      details: 'Implementation phase',
      dependencies: ['Phase 1'],
      tasks: [{
        title: 'Implement feature',
        description: 'Build the main feature',
        steps: []
      }]
    },
    {
      goal: 'Phase 3 - Testing',
      details: 'Testing phase',
      dependencies: ['Phase 2'],
      tasks: [{
        title: 'Test feature',
        description: 'Test the implemented feature',
        steps: []
      }]
    }
  ]
};

const options: ExtractMarkdownToYamlOptions = {
  output: path.join(testDir, 'multiphase-test'),
  stubPlanData: undefined,
  commit: false
};

const config = {
  ...getDefaultConfig(),
  paths: { tasks: testDir }
};

try {
  const result = await saveMultiPhaseYaml(testYaml, options, config, false);
  console.log('\nResult:', result);
  
  // Check the generated files
  const outputDir = path.join(testDir, 'multiphase-test');
  const files = await fs.readdir(outputDir);
  const phaseFiles = files.filter(f => f.startsWith('phase-')).sort();
  console.log('\nGenerated phase files:', phaseFiles);
  console.log('\nExpected IDs to start from 6 (since we have existing IDs 1, 2, and 5)');
  
  // Read and display phase IDs
  for (const file of phaseFiles) {
    const content = await fs.readFile(path.join(outputDir, file), 'utf-8');
    const yaml = await import('yaml').then(m => m.default.parse(content));
    console.log(`${file}: ID = ${yaml.id}, Goal = ${yaml.goal}, Dependencies = ${yaml.dependencies || 'none'}`);
  }
} catch (error) {
  console.error('Error:', error);
} finally {
  // Cleanup
  await fs.rm(testDir, { recursive: true, force: true });
}