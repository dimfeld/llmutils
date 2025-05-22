#!/usr/bin/env bun

import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { rmplanConfigSchema } from '../src/rmplan/configSchema.js';
import { planSchema } from '../src/rmplan/planSchema.js';
import { ConfigSchema } from '../src/rmfilter/config.js';

interface SchemaMapping {
  zodSchema: any;
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
      const jsonSchema = zodToJsonSchema(zodSchema, {
        name: schemaName,
        // Use draft-07 for better compatibility
        $refStrategy: 'none',
      });

      // Add the $schema property
      const schemaWithMeta = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        ...jsonSchema,
      };

      // Write to file with pretty formatting
      const fullPath = path.join(process.cwd(), outputPath);
      await writeFile(fullPath, JSON.stringify(schemaWithMeta, null, 2) + '\n');

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
