import { describe, expect, test } from 'vitest';
import {
  REFERENCE_ARTIFACT_PREFIX,
  buildReferenceArtifactMessage,
  isReferenceArtifact,
  parseReferenceArtifactDescription,
} from './reference.js';

describe('REFERENCE_ARTIFACT_PREFIX', () => {
  test('is the expected literal', () => {
    expect(REFERENCE_ARTIFACT_PREFIX).toBe('tim-reference:');
  });
});

describe('buildReferenceArtifactMessage', () => {
  test('with no description returns the bare prefix', () => {
    expect(buildReferenceArtifactMessage()).toBe('tim-reference:');
  });

  test('with undefined description returns the bare prefix', () => {
    expect(buildReferenceArtifactMessage(undefined)).toBe('tim-reference:');
  });

  test('with empty string description returns the bare prefix', () => {
    expect(buildReferenceArtifactMessage('')).toBe('tim-reference:');
  });

  test('with a description appends it after the prefix', () => {
    expect(buildReferenceArtifactMessage('API spec')).toBe('tim-reference:API spec');
  });
});

describe('isReferenceArtifact', () => {
  test('returns true for a prefixed message', () => {
    expect(isReferenceArtifact('tim-reference:API spec')).toBe(true);
  });

  test('returns true for the bare prefix with no description', () => {
    expect(isReferenceArtifact('tim-reference:')).toBe(true);
  });

  test('returns false for a non-prefixed message', () => {
    expect(isReferenceArtifact('just a message')).toBe(false);
  });

  test('returns false for a proof artifact message', () => {
    expect(isReferenceArtifact('tim-proof:run-123')).toBe(false);
  });

  test('returns false for an empty string', () => {
    expect(isReferenceArtifact('')).toBe(false);
  });

  test('returns false for null', () => {
    expect(isReferenceArtifact(null)).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(isReferenceArtifact(undefined)).toBe(false);
  });
});

describe('parseReferenceArtifactDescription', () => {
  test('round-trips a description', () => {
    const message = buildReferenceArtifactMessage('API spec');
    expect(parseReferenceArtifactDescription(message)).toBe('API spec');
  });

  test('returns empty string when description was empty', () => {
    const message = buildReferenceArtifactMessage('');
    expect(parseReferenceArtifactDescription(message)).toBe('');
  });

  test('returns empty string for the bare prefix', () => {
    expect(parseReferenceArtifactDescription('tim-reference:')).toBe('');
  });

  test('returns undefined for a non-reference message', () => {
    expect(parseReferenceArtifactDescription('plain message')).toBeUndefined();
  });

  test('returns undefined for a proof artifact message', () => {
    expect(parseReferenceArtifactDescription('tim-proof:run-123')).toBeUndefined();
  });

  test('returns undefined for null', () => {
    expect(parseReferenceArtifactDescription(null)).toBeUndefined();
  });

  test('returns undefined for undefined', () => {
    expect(parseReferenceArtifactDescription(undefined)).toBeUndefined();
  });
});
