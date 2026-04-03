import { expect, it } from 'bun:test';

it('no bun test', () => {
  expect('bun test', 'You should run `bun run test` instead').toBe('bun run test');
});
