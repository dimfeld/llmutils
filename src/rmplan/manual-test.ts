import * as yaml from 'js-yaml';
import { rmplanConfigSchema } from './configSchema.js';

// Test configs
const testConfigs = [
  // Empty config
  {},

  // Config with postApplyCommands
  {
    postApplyCommands: [{ title: 'Test Command', command: 'echo hello' }],
  },

  // Config with workspaceCreation method script
  {
    workspaceCreation: {
      method: 'script',
      scriptPath: '/path/to/script.sh',
    },
  },

  // Config with workspaceCreation method llmutils
  {
    workspaceCreation: {
      method: 'llmutils',
      repositoryUrl: 'https://github.com/example/repo.git',
      cloneLocation: '~/llmutils-workspaces',
      postCloneCommands: [{ title: 'Install Dependencies', command: 'npm install' }],
    },
  },

  // Config with empty workspaceCreation
  {
    workspaceCreation: {},
  },
];

// Invalid config: script without scriptPath
const invalidConfig = {
  workspaceCreation: {
    method: 'script',
  },
};

console.log('Testing valid configurations:');
testConfigs.forEach((config, index) => {
  const result = rmplanConfigSchema.safeParse(config);
  console.log(`Config ${index + 1}: ${result.success ? 'VALID' : 'INVALID'}`);
  if (!result.success) {
    console.error(result.error);
  } else {
    if (result.data.workspaceCreation) {
      console.log('  workspaceCreation:', JSON.stringify(result.data.workspaceCreation, null, 2));
    }
  }
});

console.log('\nTesting invalid configuration:');
const invalidResult = rmplanConfigSchema.safeParse(invalidConfig);
console.log(
  `Invalid config: ${invalidResult.success ? 'VALID (UNEXPECTED!)' : 'INVALID (EXPECTED)'}`
);
if (!invalidResult.success) {
  console.log('  Error:', invalidResult.error.errors[0].message);
}
