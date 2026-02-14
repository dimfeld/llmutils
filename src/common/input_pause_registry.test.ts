import { beforeEach, describe, expect, it } from 'bun:test';
import {
  getActiveInputSource,
  setActiveInputSource,
  type PausableInputSource,
} from './input_pause_registry.ts';

describe('input_pause_registry', () => {
  beforeEach(() => {
    setActiveInputSource(undefined);
  });

  it('stores and returns the active input source', () => {
    const source: PausableInputSource = {
      pause: () => {},
      resume: () => {},
    };

    setActiveInputSource(source);

    expect(getActiveInputSource()).toBe(source);
  });

  it('clears the active input source', () => {
    setActiveInputSource({
      pause: () => {},
      resume: () => {},
    });

    setActiveInputSource(undefined);

    expect(getActiveInputSource()).toBeUndefined();
  });
});
