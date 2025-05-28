#!/usr/bin/env bun
import { z } from 'zod';

// Test different schema patterns
const schema1 = z.object({
  field1: z.string().default('default1').optional(),
  field2: z.string().optional().default('default2'),
});

const schema2 = z.object({
  field1: z.string().default('default1'),
  field2: z.string().optional().default('default2'),
});

const testData = {};

console.log('Schema with .default().optional():');
console.log(schema1.parse(testData));

console.log('\nSchema with required default:');
console.log(schema2.parse(testData));
