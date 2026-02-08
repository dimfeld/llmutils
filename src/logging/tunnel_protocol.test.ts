import { describe, it, expect } from 'bun:test';
import { inspect } from 'node:util';
import {
  TIM_OUTPUT_SOCKET,
  isStructuredTunnelMessage,
  serializeArg,
  serializeArgs,
  type TunnelMessage,
  type TunnelArgsMessage,
  type TunnelDataMessage,
  type StructuredTunnelMessage,
} from './tunnel_protocol.ts';

describe('tunnel_protocol', () => {
  describe('TIM_OUTPUT_SOCKET constant', () => {
    it('should be the expected environment variable name', () => {
      expect(TIM_OUTPUT_SOCKET).toBe('TIM_OUTPUT_SOCKET');
    });
  });

  describe('serializeArg', () => {
    it('should pass strings through unchanged', () => {
      expect(serializeArg('hello')).toBe('hello');
      expect(serializeArg('')).toBe('');
      expect(serializeArg('multi\nline\nstring')).toBe('multi\nline\nstring');
    });

    it('should format numbers with util.inspect', () => {
      expect(serializeArg(42)).toBe(inspect(42));
      expect(serializeArg(3.14)).toBe(inspect(3.14));
      expect(serializeArg(NaN)).toBe(inspect(NaN));
      expect(serializeArg(Infinity)).toBe(inspect(Infinity));
    });

    it('should format booleans with util.inspect', () => {
      expect(serializeArg(true)).toBe(inspect(true));
      expect(serializeArg(false)).toBe(inspect(false));
    });

    it('should format objects with util.inspect', () => {
      const obj = { key: 'value', nested: { a: 1 } };
      expect(serializeArg(obj)).toBe(inspect(obj));
    });

    it('should format arrays with util.inspect', () => {
      const arr = [1, 'two', { three: 3 }];
      expect(serializeArg(arr)).toBe(inspect(arr));
    });

    it('should format null and undefined with util.inspect', () => {
      expect(serializeArg(null)).toBe(inspect(null));
      expect(serializeArg(undefined)).toBe(inspect(undefined));
    });

    it('should format Error objects with util.inspect', () => {
      const err = new Error('test error');
      expect(serializeArg(err)).toBe(inspect(err));
    });
  });

  describe('serializeArgs', () => {
    it('should serialize an empty array', () => {
      expect(serializeArgs([])).toEqual([]);
    });

    it('should serialize a single string argument', () => {
      expect(serializeArgs(['hello'])).toEqual(['hello']);
    });

    it('should serialize mixed arguments', () => {
      const args = ['message', 42, { key: 'value' }, true];
      const result = serializeArgs(args);
      expect(result).toEqual(['message', inspect(42), inspect({ key: 'value' }), inspect(true)]);
    });

    it('should serialize multiple string arguments unchanged', () => {
      expect(serializeArgs(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    });
  });

  describe('TunnelMessage serialization/deserialization', () => {
    it('should roundtrip an args message through JSON', () => {
      const message: TunnelArgsMessage = {
        type: 'log',
        args: ['hello', 'world'],
      };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json) as TunnelMessage;
      expect(parsed).toEqual(message);
    });

    it('should roundtrip a data message through JSON', () => {
      const message: TunnelDataMessage = {
        type: 'stdout',
        data: 'output data\n',
      };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json) as TunnelMessage;
      expect(parsed).toEqual(message);
    });

    it('should roundtrip all args message types', () => {
      const types = ['log', 'error', 'warn', 'debug'] as const;
      for (const type of types) {
        const message: TunnelArgsMessage = { type, args: ['test', 'args'] };
        const parsed = JSON.parse(JSON.stringify(message)) as TunnelMessage;
        expect(parsed).toEqual(message);
      }
    });

    it('should roundtrip all data message types', () => {
      const types = ['stdout', 'stderr'] as const;
      for (const type of types) {
        const message: TunnelDataMessage = { type, data: 'some data' };
        const parsed = JSON.parse(JSON.stringify(message)) as TunnelMessage;
        expect(parsed).toEqual(message);
      }
    });

    it('should handle args containing special characters', () => {
      const message: TunnelArgsMessage = {
        type: 'log',
        args: ['line1\nline2', 'tab\there', 'quote"s', 'backslash\\'],
      };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json) as TunnelMessage;
      expect(parsed).toEqual(message);
    });

    it('should handle empty args array', () => {
      const message: TunnelArgsMessage = { type: 'log', args: [] };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json) as TunnelMessage;
      expect(parsed).toEqual(message);
    });

    it('should handle empty data string', () => {
      const message: TunnelDataMessage = { type: 'stdout', data: '' };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json) as TunnelMessage;
      expect(parsed).toEqual(message);
    });

    it('should roundtrip a structured message through JSON', () => {
      const message: StructuredTunnelMessage = {
        type: 'structured',
        message: {
          type: 'workflow_progress',
          timestamp: '2026-02-08T00:00:00.000Z',
          message: 'Running',
        },
      };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json) as TunnelMessage;
      expect(parsed).toEqual(message);
      expect(isStructuredTunnelMessage(parsed)).toBe(true);
    });

    it('isStructuredTunnelMessage returns false for non-structured messages', () => {
      const logMessage: TunnelMessage = { type: 'log', args: ['hello'] };
      expect(isStructuredTunnelMessage(logMessage)).toBe(false);
    });
  });
});
