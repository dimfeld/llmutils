import yaml from 'yaml';
import * as fs from 'node:fs/promises';

const plan = {
  id: 200,
  title: 'Test Plan',
  status: 'pending',
  tasks: [{ title: 'Task 1', done: false }]
};

// Write without document separator
const yamlContent = yaml.stringify(plan, { lineWidth: -1 });
console.log('YAML content:');
console.log(yamlContent);

await fs.writeFile('/Users/dimfeld/Documents/projects/llmutils/test.yml', yamlContent.replace(/^---\n/, ''));

// Read back
const readContent = await fs.readFile('/Users/dimfeld/Documents/projects/llmutils/test.yml', 'utf-8');
console.log('\nRead content:');
console.log(readContent);

// Parse back
const parsed = yaml.parse(readContent);
console.log('\nParsed:');
console.log(parsed);

// Modify and write again
parsed.tasks[0].done = true;
const modifiedYaml = yaml.stringify(parsed, { lineWidth: -1 });
console.log('\nModified YAML:');
console.log(modifiedYaml);

await fs.writeFile('/Users/dimfeld/Documents/projects/llmutils/test.yml', modifiedYaml.replace(/^---\n/, ''));

// Final read
const finalContent = await fs.readFile('/Users/dimfeld/Documents/projects/llmutils/test.yml', 'utf-8');
console.log('\nFinal content:');
console.log(finalContent);

// Final parse
const finalParsed = yaml.parse(finalContent);
console.log('\nFinal parsed:');
console.log(finalParsed);