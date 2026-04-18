import { describe, expect, test } from 'vitest';
import { getRootCommandOptions } from './command_context.js';

describe('getRootCommandOptions', () => {
  test('returns options from the root command when nested', () => {
    const command = {
      parent: {
        parent: {
          opts: () => ({ config: '/tmp/tim.yml', verbose: true }),
        },
      },
    };

    expect(getRootCommandOptions(command)).toEqual({
      config: '/tmp/tim.yml',
      verbose: true,
    });
  });

  test('returns an empty object when no command opts are available', () => {
    expect(getRootCommandOptions({})).toEqual({});
  });
});
