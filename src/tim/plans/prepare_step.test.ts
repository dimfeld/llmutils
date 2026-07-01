import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeDatabaseForTesting } from '../db/database.js';
import { addArtifactByPlanUuid } from '../artifacts/service.js';
import { buildReferenceArtifactMessage } from '../artifacts/reference.js';
import { getDefaultConfig } from '../configSchema.js';
import { readPlanFile, writePlanFile } from '../plans.js';
import { REFERENCE_ARTIFACTS_DIR } from '../reference_artifacts.js';
import { prepareNextStep } from './prepare_step.js';

describe('prepareNextStep - reference artifacts', () => {
  let tempDir: string;
  let tasksDir: string;
  let originalCwd: string;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tim-prepare-step-test-')));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await Bun.$`git init`.cwd(tempDir).quiet();

    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tempDir, 'data');
    closeDatabaseForTesting();

    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    closeDatabaseForTesting();
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('includes a Reference Artifacts section with the deterministic materialized path for a stepped task', async () => {
    const planPath = path.join(tasksDir, '777-test-plan.yml');
    await writePlanFile(
      planPath,
      {
        id: 777,
        title: 'Stepped Plan With Reference Artifacts',
        goal: 'Verify the stepped execution path materializes reference artifacts',
        details: 'prepareNextStep should reuse the shared materializer',
        status: 'pending',
        tasks: [
          {
            title: 'Task 1',
            description: 'A task with an explicit step',
            done: false,
            steps: [{ prompt: 'implement it', done: false }],
          },
        ],
      },
      { cwdForIdentity: tempDir }
    );
    const writtenPlan = await readPlanFile(planPath);
    if (!writtenPlan.uuid) {
      throw new Error('Test plan was written without a uuid');
    }

    const artifactSourcePath = path.join(tempDir, 'reference-source.md');
    await fs.writeFile(artifactSourcePath, 'reference artifact content');
    await addArtifactByPlanUuid({
      planUuid: writtenPlan.uuid,
      sourcePath: artifactSourcePath,
      originalFilename: 'reference-source.md',
      message: buildReferenceArtifactMessage('spec doc'),
    });

    const { prompt } = await prepareNextStep(getDefaultConfig(), planPath, {}, tempDir);

    const expectedRelativePath = path.join(REFERENCE_ARTIFACTS_DIR, '777', 'reference-source.md');
    expect(prompt).toContain('## Reference Artifacts');
    expect(prompt).toContain(expectedRelativePath);

    const materializedContent = await fs.readFile(path.join(tempDir, expectedRelativePath), 'utf8');
    expect(materializedContent).toBe('reference artifact content');
  });

  test('omits the Reference Artifacts section when the plan has no reference artifacts', async () => {
    const planPath = path.join(tasksDir, '778-test-plan.yml');
    await writePlanFile(
      planPath,
      {
        id: 778,
        title: 'Stepped Plan Without Reference Artifacts',
        goal: 'Verify the section is omitted when there is nothing to materialize',
        details: 'No reference artifacts attached',
        status: 'pending',
        tasks: [
          {
            title: 'Task 1',
            description: 'A task with an explicit step',
            done: false,
            steps: [{ prompt: 'implement it', done: false }],
          },
        ],
      },
      { cwdForIdentity: tempDir }
    );

    const { prompt } = await prepareNextStep(getDefaultConfig(), planPath, {}, tempDir);

    expect(prompt).not.toContain('## Reference Artifacts');
    await expect(fs.stat(path.join(tempDir, REFERENCE_ARTIFACTS_DIR, '778'))).rejects.toMatchObject(
      { code: 'ENOENT' }
    );
  });
});
