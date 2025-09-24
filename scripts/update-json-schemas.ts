#!/usr/bin/env bun

import { z } from 'zod/v4';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { rmplanConfigSchema } from '../src/rmplan/configSchema.js';
import { planSchema } from '../src/rmplan/planSchema.js';
import { ConfigSchema } from '../src/rmfilter/config.js';

interface SchemaMapping {
  zodSchema: z.ZodType<any, any>;
  outputPath: string;
  schemaName: string;
}

const schemaMappings: SchemaMapping[] = [
  {
    zodSchema: rmplanConfigSchema,
    outputPath: 'schema/rmplan-config-schema.json',
    schemaName: 'RmplanConfig',
  },
  {
    zodSchema: planSchema,
    outputPath: 'schema/rmplan-plan-schema.json',
    schemaName: 'RmplanPlan',
  },
  {
    zodSchema: ConfigSchema,
    outputPath: 'schema/rmfilter-config-schema.json',
    schemaName: 'RmfilterConfig',
  },
];

async function updateSchemas() {
  console.log('Updating JSON schema files...\n');

  for (const { zodSchema, outputPath, schemaName } of schemaMappings) {
    try {
      // Convert Zod schema to JSON Schema
      const jsonSchema = z.toJSONSchema(zodSchema, {
        target: 'draft-7',
        io: 'input',
      });

      // Write to file with pretty formatting
      const fullPath = path.join(process.cwd(), outputPath);
      await writeFile(fullPath, JSON.stringify(jsonSchema, null, 2) + '\n');

      console.log(`✅ Updated ${outputPath}`);
    } catch (error) {
      console.error(`❌ Failed to update ${outputPath}:`, error);
      process.exit(1);
    }
  }

  console.log('\nAll schemas updated successfully!');
}

// Run the update
updateSchemas().catch((error) => {
  console.error('Failed to update schemas:', error);
  process.exit(1);
});
