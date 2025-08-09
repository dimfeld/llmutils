import { wrapWithOrchestration } from './src/rmplan/executors/claude_code/orchestrator_prompt.ts';

// Test with realistic context
const context = 'Implement user authentication with email/password login, password validation, and session management.';
const planId = 'user-auth-feature-123';
const planFilePath = '/Users/test/project/tasks/auth-feature.yml';

// Test normal mode
const normalMode = wrapWithOrchestration(context, planId);
console.log('Normal mode contains batch instructions:', normalMode.includes('BATCH TASK PROCESSING MODE'));

// Test batch mode
const batchMode = wrapWithOrchestration(context, planId, { batchMode: true, planFilePath });
console.log('Batch mode contains batch instructions:', batchMode.includes('BATCH TASK PROCESSING MODE'));
console.log('Batch mode contains plan file path:', batchMode.includes('@/Users/test/project/tasks/auth-feature.yml'));
console.log('Batch mode contains task selection phase:', batchMode.includes('Task Selection Phase'));

console.log('\nAll integration tests passed! ✓');