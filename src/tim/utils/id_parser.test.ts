import { describe, test, expect } from 'bun:test';
import { parseTaskIds } from './id_parser.js';

describe('parseTaskIds', () => {
  test('parses single task ID', () => {
    const result = parseTaskIds(['35.2']);
    expect(result).toEqual([{ planId: '35', taskIndex: 1 }]); // 0-based index
  });

  test('parses multiple single task IDs', () => {
    const result = parseTaskIds(['35.2', '36.1', '37.3']);
    expect(result).toEqual([
      { planId: '35', taskIndex: 1 },
      { planId: '36', taskIndex: 0 },
      { planId: '37', taskIndex: 2 },
    ]);
  });

  test('parses task range within single plan', () => {
    const result = parseTaskIds(['35.2-5']);
    expect(result).toEqual([
      { planId: '35', taskIndex: 1 },
      { planId: '35', taskIndex: 2 },
      { planId: '35', taskIndex: 3 },
      { planId: '35', taskIndex: 4 },
    ]);
  });

  test('parses single task range starting from 1', () => {
    const result = parseTaskIds(['35.1-3']);
    expect(result).toEqual([
      { planId: '35', taskIndex: 0 },
      { planId: '35', taskIndex: 1 },
      { planId: '35', taskIndex: 2 },
    ]);
  });

  test('parses mix of single tasks and ranges', () => {
    const result = parseTaskIds(['35.1', '36.2-4', '37.1']);
    expect(result).toEqual([
      { planId: '35', taskIndex: 0 },
      { planId: '36', taskIndex: 1 },
      { planId: '36', taskIndex: 2 },
      { planId: '36', taskIndex: 3 },
      { planId: '37', taskIndex: 0 },
    ]);
  });

  test('handles alphanumeric plan IDs', () => {
    const result = parseTaskIds(['abc123.2', 'xyz.1-2']);
    expect(result).toEqual([
      { planId: 'abc123', taskIndex: 1 },
      { planId: 'xyz', taskIndex: 0 },
      { planId: 'xyz', taskIndex: 1 },
    ]);
  });

  test('throws error for invalid format - missing dot', () => {
    expect(() => parseTaskIds(['35'])).toThrow('Invalid task ID format');
  });

  test('throws error for invalid format - multiple dots', () => {
    expect(() => parseTaskIds(['35.2.3'])).toThrow('Invalid task ID format');
  });

  test('throws error for invalid format - non-numeric task index', () => {
    expect(() => parseTaskIds(['35.abc'])).toThrow('Invalid task ID format');
  });

  test('throws error for invalid format - non-numeric range', () => {
    expect(() => parseTaskIds(['35.abc-def'])).toThrow('Invalid task ID format');
  });

  test('throws error for invalid range - start greater than end', () => {
    expect(() => parseTaskIds(['35.5-2'])).toThrow(
      'Invalid range: start index cannot be greater than end index'
    );
  });

  test('throws error for zero task index', () => {
    expect(() => parseTaskIds(['35.0'])).toThrow('Task indices must be 1-based (greater than 0)');
  });

  test('throws error for zero in range', () => {
    expect(() => parseTaskIds(['35.0-2'])).toThrow('Task indices must be 1-based (greater than 0)');
  });

  test('throws error for negative task index', () => {
    expect(() => parseTaskIds(['35.-1'])).toThrow('Range parts cannot be empty');
  });

  test('throws error for empty plan ID', () => {
    expect(() => parseTaskIds(['.1'])).toThrow('Invalid task ID format');
  });

  test('throws error for empty task ID array', () => {
    expect(() => parseTaskIds([])).toThrow('No task IDs provided');
  });

  test('throws error for empty string in array', () => {
    expect(() => parseTaskIds([''])).toThrow('Invalid task ID format');
  });

  test('handles single task (no range)', () => {
    const result = parseTaskIds(['35.1-1']);
    expect(result).toEqual([{ planId: '35', taskIndex: 0 }]);
  });

  test('preserves order from input array', () => {
    const result = parseTaskIds(['37.1', '35.2-3', '36.1']);
    expect(result).toEqual([
      { planId: '37', taskIndex: 0 },
      { planId: '35', taskIndex: 1 },
      { planId: '35', taskIndex: 2 },
      { planId: '36', taskIndex: 0 },
    ]);
  });
});
