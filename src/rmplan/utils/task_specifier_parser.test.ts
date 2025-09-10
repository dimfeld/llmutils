import { describe, expect, test } from 'bun:test';
import { parseTaskSpecifier } from './task_specifier_parser.js';

describe('parseTaskSpecifier', () => {
  test('parses single number', () => {
    expect(parseTaskSpecifier('1')).toEqual([0]);
    expect(parseTaskSpecifier('5')).toEqual([4]);
  });

  test('parses simple range', () => {
    expect(parseTaskSpecifier('1-3')).toEqual([0, 1, 2]);
    expect(parseTaskSpecifier('2-2')).toEqual([1]);
  });

  test('parses combinations with commas', () => {
    expect(parseTaskSpecifier('1,3,5')).toEqual([0, 2, 4]);
    expect(parseTaskSpecifier('1-3,5')).toEqual([0, 1, 2, 4]);
  });

  test('handles whitespace around tokens and hyphen', () => {
    expect(parseTaskSpecifier(' 1 - 3 , 5 ')).toEqual([0, 1, 2, 4]);
    expect(parseTaskSpecifier('  2  ')).toEqual([1]);
  });

  test('deduplicates and sorts indices', () => {
    expect(parseTaskSpecifier('3,1,2,2,1')).toEqual([0, 1, 2]);
    expect(parseTaskSpecifier('2-4,3-5,1')).toEqual([0, 1, 2, 3, 4]);
  });

  test('errors on empty string or missing', () => {
    expect(() => parseTaskSpecifier('')).toThrow();
    // @ts-expect-error testing runtime error for undefined
    expect(() => parseTaskSpecifier(undefined)).toThrow();
  });

  test('errors on zero or negative indices', () => {
    expect(() => parseTaskSpecifier('0')).toThrow();
    expect(() => parseTaskSpecifier('-1')).toThrow();
    expect(() => parseTaskSpecifier('0-3')).toThrow();
    expect(() => parseTaskSpecifier('3-0')).toThrow();
  });

  test('errors on invalid ranges', () => {
    expect(() => parseTaskSpecifier('3-2')).toThrow();
    expect(() => parseTaskSpecifier('1--3')).toThrow();
    expect(() => parseTaskSpecifier('1-3-5')).toThrow();
  });

  test('errors on malformed segments and repeated commas', () => {
    expect(() => parseTaskSpecifier('1,,3')).toThrow();
    expect(() => parseTaskSpecifier('a,b')).toThrow();
    expect(() => parseTaskSpecifier(' , ')).toThrow();
  });
});
