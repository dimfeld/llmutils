import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getDefaultConfig } from '../configSchema.js';
import { getArtifactByUuid } from '../db/artifact.js';
import {
  setupArtifactCommandTest,
  type ArtifactCommandTestContext,
} from '../commands/artifact/test_utils.js';
import { attachPlanArtifactTool } from './attach_plan_artifact.js';
import type { ToolContext } from './context.js';

describe('attachPlanArtifactTool', () => {
  let context: ArtifactCommandTestContext;

  beforeEach(async () => {
    context = await setupArtifactCommandTest();
  });

  afterEach(async () => {
    await context.restore();
  });

  test('attaches a file and returns artifact fields', async () => {
    const sourcePath = path.join(context.sourceDir, 'tool.txt');
    await fs.writeFile(sourcePath, 'tool output');
    const toolContext: ToolContext = {
      config: getDefaultConfig(),
      gitRoot: context.tempDir,
    };

    const result = await attachPlanArtifactTool(
      { planId: 1, filePath: sourcePath, message: 'from mcp' },
      toolContext
    );

    expect(result.data).toMatchObject({
      filename: 'tool.txt',
      mimeType: 'text/plain',
      size: 11,
    });
    expect(getArtifactByUuid(context.db, result.data!.uuid)).toMatchObject({
      message: 'from mcp',
    });
  });
});
