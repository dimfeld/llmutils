import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getDefaultConfig } from '../configSchema.js';
import { getArtifactByUuid } from '../db/artifact.js';
import { MAX_ARTIFACT_BYTES } from '../artifacts/constants.js';
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
    expect(result.data?.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(getArtifactByUuid(context.db, result.data!.uuid)).toMatchObject({
      message: 'from mcp',
    });
  });

  test('rejects missing source file', async () => {
    const toolContext: ToolContext = {
      config: getDefaultConfig(),
      gitRoot: context.tempDir,
    };
    await expect(
      attachPlanArtifactTool(
        { planId: 1, filePath: path.join(context.sourceDir, 'missing.txt') },
        toolContext
      )
    ).rejects.toThrow(/does not exist/);
  });

  test('rejects file exceeding size cap', async () => {
    const largePath = path.join(context.sourceDir, 'large.bin');
    const file = await fs.open(largePath, 'w');
    try {
      await file.truncate(MAX_ARTIFACT_BYTES + 1);
    } finally {
      await file.close();
    }
    const toolContext: ToolContext = {
      config: getDefaultConfig(),
      gitRoot: context.tempDir,
    };
    await expect(
      attachPlanArtifactTool({ planId: 1, filePath: largePath }, toolContext)
    ).rejects.toThrow(/too large/);
  });

  test('output data shape contains uuid, filename, mimeType, size', async () => {
    const sourcePath = path.join(context.sourceDir, 'shape.png');
    await fs.writeFile(sourcePath, 'fake png');
    const toolContext: ToolContext = {
      config: getDefaultConfig(),
      gitRoot: context.tempDir,
    };

    const result = await attachPlanArtifactTool({ planId: 1, filePath: sourcePath }, toolContext);

    expect(Object.keys(result.data!).sort()).toEqual(['filename', 'mimeType', 'size', 'uuid']);
    expect(result.data!.filename).toBe('shape.png');
    expect(result.data!.mimeType).toBe('image/png');
  });
});
