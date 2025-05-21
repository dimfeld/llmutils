// Test to see if js-yaml can be imported
import yaml from 'js-yaml';
console.log('js-yaml imported successfully');

const test = yaml.dump({ hello: 'world' });
console.log(test);