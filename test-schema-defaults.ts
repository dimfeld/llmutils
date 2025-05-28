#!/usr/bin/env bun
import { planSchema } from './src/rmplan/planSchema.js';

const testData = {
  goal: 'Test goal',
  details: 'Test details',
  tasks: [
    {
      title: 'Test task',
      description: 'Test description',
      files: ['test.ts'],
      steps: [{ prompt: 'Test step' }],
    },
  ],
};

const result = planSchema.parse(testData);
console.log('Parsed result:');
console.log('status:', result.status);
console.log('priority:', result.priority);
console.log('dependencies:', result.dependencies);
console.log('changedFiles:', result.changedFiles);
console.log('rmfilter:', result.rmfilter);
console.log('issue:', result.issue);
console.log('pullRequest:', result.pullRequest);
