import { test, expect } from 'bun:test';
import { cleanComments } from './cleanup';

test('cleanComments removes TypeScript EOL comments', () => {
  const input = `
    let x = 1; // This is a comment
    let y = 2;
    // Another comment
    let z = 3; /* inline comment */
  `;
  const expected = `
    let x = 1;
    let y = 2;
    // Another comment
    let z = 3;
  `;
  const { cleanedContent, linesCleaned } = cleanComments(input, '.ts');
  expect(cleanedContent.trim()).toEqual(expected.trim());
  expect(linesCleaned).toBe(2);
});

test('cleanComments removes Python EOL comments', () => {
  const input = `
    x = 1 # This is a comment
    y = 2
    # Another comment
    z = 3
  `;
  const expected = `
    x = 1
    y = 2
    # Another comment
    z = 3
  `;
  const { cleanedContent, linesCleaned } = cleanComments(input, '.py');
  expect(cleanedContent.trim()).toEqual(expected.trim());
  expect(linesCleaned).toBe(1);
});

test('cleanComments handles Svelte invalid template comments', () => {
  const input = `
    <div>
      {/* Invalid comment */}
      <p>Hello</p>
    </div>
  `;
  const expected = `
    <div>
      <!-- Invalid comment -->
      <p>Hello</p>
    </div>
  `;
  const { cleanedContent, linesCleaned } = cleanComments(input, '.svelte');
  expect(cleanedContent.trim()).toEqual(expected.trim());
  expect(linesCleaned).toBe(1);
});

test('cleanComments returns unchanged content for unsupported extension', () => {
  const input = `
    content: some text // comment
  `;
  const result = cleanComments(input, '.txt');
  expect(result).toBeUndefined();
});
