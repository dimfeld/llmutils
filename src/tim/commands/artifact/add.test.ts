import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getArtifactByUuid } from '../../db/artifact.js';
import { handleArtifactAddCommand } from './add.js';
import { setupArtifactCommandTest, type ArtifactCommandTestContext } from './test_utils.js';

describe('tim artifact add command', () => {
  let context: ArtifactCommandTestContext;
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    context = await setupArtifactCommandTest();
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    consoleLog.mockRestore();
    await context.restore();
  });

  test('prints JSON and inserts the artifact', async () => {
    const sourcePath = path.join(context.sourceDir, 'capture.txt');
    await fs.writeFile(sourcePath, 'capture');

    await handleArtifactAddCommand('1', sourcePath, { message: 'run log', json: true });

    const payload = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string) as { uuid: string };
    expect(payload).toMatchObject({
      filename: 'capture.txt',
      mimeType: 'text/plain',
      size: 7,
      planUuid: '22222222-2222-4222-8222-222222222222',
    });
    expect(getArtifactByUuid(context.db, payload.uuid)).toMatchObject({
      message: 'run log',
      filename: 'capture.txt',
    });
  });
});
