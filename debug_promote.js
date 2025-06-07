import { parseTaskIds } from './src/rmplan/utils/id_parser.js';

console.log('Testing parseTaskIds with 1.2-4:');
const result = parseTaskIds(['1.2-4']);
console.log('Result:', result);