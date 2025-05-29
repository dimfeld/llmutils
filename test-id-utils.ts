import { generateProjectId, generatePhaseId } from './src/rmplan/id_utils.js';

// Test generateProjectId
console.log('Testing generateProjectId:');
console.log('  Title: "My Awesome Project" =>', generateProjectId('My Awesome Project'));
console.log(
  '  Title: "Feature: Add OAuth2 Support!" =>',
  generateProjectId('Feature: Add OAuth2 Support!')
);
console.log('  Title: "  Trim  Spaces  " =>', generateProjectId('  Trim  Spaces  '));
console.log('  Title: "123-numbers-and-dashes" =>', generateProjectId('123-numbers-and-dashes'));

// Test generatePhaseId
console.log('\nTesting generatePhaseId:');
const projectId = generateProjectId('Test Project');
console.log('  Project ID:', projectId);
console.log('  Phase 1:', generatePhaseId(projectId, 1));
console.log('  Phase 2:', generatePhaseId(projectId, 2));
console.log('  Phase 5:', generatePhaseId(projectId, 5));
