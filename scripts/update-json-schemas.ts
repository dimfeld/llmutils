#!/usr/bin/env bun

import { z } from 'zod/v4';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { timConfigSchema } from '../src/tim/configSchema.js';
import { planSchema } from '../src/tim/planSchema.js';
import { ConfigSchema } from '../src/rmfilter/config.js';

interface SchemaMapping {
  zodSchema: z.ZodType<any, any>;
  outputPath: string;
  schemaName: string;
}

const schemaMappings: SchemaMapping[] = [
  {
    zodSchema: timConfigSchema,
    outputPath: 'schema/tim-config-schema.json',
    schemaName: 'TimConfig',
  },
  {
    zodSchema: planSchema,
    outputPath: 'schema/tim-plan-schema.json',
    schemaName: 'TimPlan',
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
