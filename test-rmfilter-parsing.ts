import { parseCommandOptionsFromComment } from './src/rmpr/comment_options.ts';

// Test parsing rmfilter comments
const testComment = `This is a regular comment.

rmfilter: --with-imports --model anthropic/claude-3-opus-20240229

Some more regular text.

--rmfilter --with-all-imports src/**/*.ts

And even more text.`;

console.log('Testing rmfilter comment parsing:');
const result = parseCommandOptionsFromComment(testComment, 'rmfilter');
console.log('Parsed options:', result.options);
console.log('Cleaned comment:', result.cleanedComment);
console.log('\nExpected rmfilter args:', result.options?.rmfilter);
