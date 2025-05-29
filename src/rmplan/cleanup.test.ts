import { test, expect, mock, describe } from 'bun:test';
import { cleanComments } from './cleanup';
import type { RmplanConfig } from './configSchema.ts';
import type { PlanSchema } from './planSchema.ts';
import { prepareNextStep } from './actions.ts';
import yaml from 'yaml';

describe('cleanComments', () => {
  test('removes TypeScript EOL comments', () => {
    const input = `
    let x = 1;
    let y = 2;
    // Another comment
    let z = 3;
    let stringWithHash = '# This is a comment';
    let regexWithDoubleSlash = /regex]//;
  `;
    const expected = `
    let x = 1;
    let y = 2;
    // Another comment
    let z = 3;
    let stringWithHash = '# This is a comment';
    let regexWithDoubleSlash = /regex]//;
  `;
    const { cleanedContent, linesCleaned } = cleanComments(input, '.ts');
    expect(cleanedContent.trim()).toEqual(expected.trim());
    expect(linesCleaned).toBe(2);
  });

  test('removes Python EOL comments', () => {
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

  test('handles Svelte invalid template comments', () => {
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

  test('returns unchanged content for unsupported extension', () => {
    const input = `
    content: some text
  `;
    const result = cleanComments(input, '.txt');
    expect(result).toBeUndefined();
  });
});

test('prepareNextStep includes autoexamples when present in prompt', async () => {
  const mockConfig: RmplanConfig = {
    postApplyCommands: [],
    autoexamples: ['example1', 'example2'],
  };

  const plan: PlanSchema = {
    id: 'test-plan-id',
    goal: 'Test plan',
    details: 'Test details',
    tasks: [
      {
        title: 'Test task',
        description: 'Test description',
        files: ['test.ts'],
        steps: [
          {
            prompt: 'This step includes example1 in its prompt',
            done: false,
          },
        ],
      },
    ],
  };

  const planFile = 'test-plan.yml';
  await Bun.write(planFile, yaml.stringify(plan));

  try {
    const result = await prepareNextStep(mockConfig, planFile, { rmfilter: true });

    expect(result.rmfilterArgs).toContain('--example');
    expect(result.rmfilterArgs).toContain('example1');
    expect(result.rmfilterArgs).not.toContain('example2');
  } finally {
    await Bun.file(planFile)
      .unlink()
      .catch(() => {});
  }
});
