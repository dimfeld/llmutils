import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepositoryIdentity } from './assignments/workspace_identifier.js';
import { closeDatabaseForTesting, getDatabase } from './db/database.js';
import { addArtifact, addArtifactByPlanUuid, softDeleteArtifact } from './artifacts/service.js';
import { buildReferenceArtifactMessage } from './artifacts/reference.js';
import { createZip } from './artifacts/zip.js';
import { writePlanToDb } from './plans.js';
import {
  collectReferenceArtifacts,
  getReferenceArtifactsDir,
  materializeReferenceArtifacts,
  materializeReferenceArtifactsForExecution,
  materializeReferenceArtifactsForPlan,
  REFERENCE_ARTIFACTS_DIR,
} from './reference_artifacts.js';

describe('reference_artifacts', () => {
  let tempDir: string;
  let repoRoot: string;
  let sourceDir: string;
  let repositoryId: string;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-reference-artifacts-test-'));
    repoRoot = path.join(tempDir, 'repo');
    sourceDir = path.join(tempDir, 'source');
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tempDir, 'data');
    closeDatabaseForTesting();

    const repository = await getRepositoryIdentity({ cwd: repoRoot });
    repositoryId = repository.repositoryId;
  });

  afterEach(async () => {
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

  async function makePlan(
    id: number,
    overrides: { title?: string; parent?: number } = {}
  ): Promise<{ id: number; uuid: string }> {
    const plan = await writePlanToDb(
      {
        id,
        title: overrides.title ?? `Plan ${id}`,
        goal: 'goal',
        details: 'details',
        status: 'pending',
        parent: overrides.parent,
        tasks: [],
      },
      { cwdForIdentity: repoRoot }
    );
    if (!plan.uuid) {
      throw new Error(`Plan ${id} was written without a uuid`);
    }
    return { id, uuid: plan.uuid };
  }

  async function attachArtifact(
    planUuid: string,
    filename: string,
    content: string,
    options: { reference?: boolean; description?: string } = {}
  ) {
    const sourcePath = path.join(sourceDir, `${planUuid}-${filename.replace(/\//g, '_')}`);
    await fs.writeFile(sourcePath, content);
    const message =
      options.reference === false ? undefined : buildReferenceArtifactMessage(options.description);
    return addArtifactByPlanUuid({
      planUuid,
      sourcePath,
      originalFilename: filename,
      message,
    });
  }

  test('getReferenceArtifactsDir builds the deterministic per-plan path', () => {
    expect(getReferenceArtifactsDir(repoRoot, 42)).toBe(
      path.join(repoRoot, REFERENCE_ARTIFACTS_DIR, '42')
    );
  });

  test('a plan with no parent surfaces only its own reference artifacts', async () => {
    const plan = await makePlan(1);
    await attachArtifact(plan.uuid, 'spec.md', 'spec content');
    // Non-reference artifact should be excluded.
    await attachArtifact(plan.uuid, 'plain.txt', 'plain content', {
      reference: false,
    });

    const artifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 1,
      repositoryId,
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filename).toBe('spec.md');
  });

  test('collects reference artifacts from the plan and every ancestor, nearest first', async () => {
    const grandparent = await makePlan(1, { title: 'Grandparent' });
    const parent = await makePlan(2, { title: 'Parent', parent: 1 });
    const child = await makePlan(3, { title: 'Child', parent: 2 });

    await attachArtifact(grandparent.uuid, 'grandparent-design.md', 'grandparent content');
    await attachArtifact(parent.uuid, 'parent-notes.md', 'parent content');
    await attachArtifact(child.uuid, 'child-notes.md', 'child content');

    const artifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 3,
      repositoryId,
    });

    expect(artifacts.map((a) => a.filename)).toEqual([
      'child-notes.md',
      'parent-notes.md',
      'grandparent-design.md',
    ]);
    expect(artifacts.every((a) => a.sourcePlanId !== undefined)).toBe(true);
    expect(artifacts.find((a) => a.filename === 'child-notes.md')?.sourcePlanId).toBe(3);
    expect(artifacts.find((a) => a.filename === 'parent-notes.md')?.sourcePlanId).toBe(2);
    expect(artifacts.find((a) => a.filename === 'grandparent-design.md')?.sourcePlanId).toBe(1);
  });

  test('guards against a parent cycle without infinite looping', async () => {
    // Plan A's parent is Plan B and Plan B's parent is Plan A. The normal
    // sync-aware write path rejects circular parents, so the cycle is forced
    // directly on the projection table (mirroring how a corrupt/legacy DB
    // state could still reach the parent-chain walk).
    const planA = await makePlan(1, { title: 'A' });
    const planB = await makePlan(2, { title: 'B', parent: 1 });
    getDatabase()
      .prepare('UPDATE plan SET parent_uuid = ? WHERE uuid = ?')
      .run(planB.uuid, planA.uuid);

    await attachArtifact(planA.uuid, 'a.md', 'a content');
    await attachArtifact(planB.uuid, 'b.md', 'b content');

    const artifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 1,
      repositoryId,
    });

    // Each plan is visited exactly once despite the cycle.
    expect(artifacts.map((a) => a.filename).toSorted()).toEqual(['a.md', 'b.md']);
  });

  test('skips soft-deleted reference artifacts', async () => {
    const plan = await makePlan(1);
    const kept = await attachArtifact(plan.uuid, 'kept.md', 'kept content');
    const deleted = await attachArtifact(plan.uuid, 'deleted.md', 'deleted content');
    await softDeleteArtifact(deleted.uuid);

    const artifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 1,
      repositoryId,
    });

    expect(artifacts.map((a) => a.filename)).toEqual(['kept.md']);
    expect(artifacts[0].uuid).toBe(kept.uuid);
  });

  test('skips file-missing reference artifacts without crashing', async () => {
    const plan = await makePlan(1);
    const present = await attachArtifact(plan.uuid, 'present.md', 'present content');
    const missing = await attachArtifact(plan.uuid, 'missing.md', 'missing content');
    await fs.rm(missing.storagePath, { force: true });

    const artifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 1,
      repositoryId,
    });

    expect(artifacts.map((a) => a.filename)).toEqual(['present.md']);
    expect(artifacts[0].uuid).toBe(present.uuid);

    // Materializing should not throw even though a missing artifact was filtered out upstream.
    const result = await materializeReferenceArtifacts(repoRoot, 1, artifacts);
    expect(result.artifactPaths).toEqual([path.join(REFERENCE_ARTIFACTS_DIR, '1', 'present.md')]);
  });

  test('materializes artifacts into the deterministic per-plan directory', async () => {
    const plan = await makePlan(1);
    await attachArtifact(plan.uuid, 'spec.md', 'spec content');

    const artifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 1,
      repositoryId,
    });
    const result = await materializeReferenceArtifacts(repoRoot, 1, artifacts);

    expect(result.artifactPaths).toEqual([path.join(REFERENCE_ARTIFACTS_DIR, '1', 'spec.md')]);
    const written = await fs.readFile(path.join(repoRoot, result.artifactPaths[0]), 'utf8');
    expect(written).toBe('spec content');
  });

  test('unzips a ZIP reference artifact into a subdirectory named after the archive', async () => {
    const plan = await makePlan(1);
    const zip = createZip([
      { filename: 'a.md', data: Buffer.from('alpha') },
      { filename: 'nested/b.md', data: Buffer.from('beta') },
    ]);
    const zipSource = path.join(sourceDir, 'docs.zip');
    await fs.writeFile(zipSource, zip);
    await addArtifactByPlanUuid({
      planUuid: plan.uuid,
      sourcePath: zipSource,
      originalFilename: 'docs.zip',
      message: buildReferenceArtifactMessage(),
    });

    const artifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 1,
      repositoryId,
    });
    const result = await materializeReferenceArtifacts(repoRoot, 1, artifacts);

    // The extraction directory (not the archive file) is reported.
    expect(result.artifactPaths).toEqual([path.join(REFERENCE_ARTIFACTS_DIR, '1', 'docs')]);

    const extractedDir = path.join(getReferenceArtifactsDir(repoRoot, 1), 'docs');
    expect(await fs.readFile(path.join(extractedDir, 'a.md'), 'utf8')).toBe('alpha');
    expect(await fs.readFile(path.join(extractedDir, 'nested', 'b.md'), 'utf8')).toBe('beta');
    // The archive file itself must not be written.
    await expect(
      fs.stat(path.join(getReferenceArtifactsDir(repoRoot, 1), 'docs.zip'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('does not create an empty per-plan directory when there are no artifacts', async () => {
    const result = await materializeReferenceArtifacts(repoRoot, 1, []);

    expect(result.artifactPaths).toEqual([]);
    await expect(fs.stat(getReferenceArtifactsDir(repoRoot, 1))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('clears an existing per-plan directory when the artifact list becomes empty', async () => {
    const plan = await makePlan(1);
    await attachArtifact(plan.uuid, 'removed.md', 'removed content');

    const initialArtifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 1,
      repositoryId,
    });
    await materializeReferenceArtifacts(repoRoot, 1, initialArtifacts);

    const stalePath = path.join(getReferenceArtifactsDir(repoRoot, 1), 'removed.md');
    await expect(fs.readFile(stalePath, 'utf8')).resolves.toBe('removed content');

    const result = await materializeReferenceArtifacts(repoRoot, 1, []);

    expect(result.artifactPaths).toEqual([]);
    await expect(fs.stat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('refuses to clear when the reference artifacts path contains a symlink', async () => {
    const plan = await makePlan(1);
    await attachArtifact(plan.uuid, 'spec.md', 'spec content');
    const artifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 1,
      repositoryId,
    });

    const outsideDir = path.join(tempDir, 'outside-reference-artifacts');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, 'keep.txt'), 'must survive');

    const referenceArtifactsRoot = path.join(repoRoot, REFERENCE_ARTIFACTS_DIR);
    await fs.mkdir(referenceArtifactsRoot, { recursive: true });
    await fs.symlink(outsideDir, getReferenceArtifactsDir(repoRoot, 1), 'dir');

    await expect(materializeReferenceArtifacts(repoRoot, 1, artifacts)).rejects.toThrow(
      /reference artifacts path contains a symlinked component/
    );
    await expect(fs.readFile(path.join(outsideDir, 'keep.txt'), 'utf8')).resolves.toBe(
      'must survive'
    );
  });

  test('refuses traversal-like plan ids without clearing repo files', async () => {
    const targetDir = path.join(repoRoot, 'src');
    const targetPath = path.join(targetDir, 'keep.ts');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(targetPath, 'must survive');

    await expect(
      materializeReferenceArtifacts(repoRoot, '../src' as unknown as number, [])
    ).rejects.toThrow(/Invalid reference artifact plan id segment|must be a managed subdirectory/);

    await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('must survive');
  });

  test('child-wins: nearest plan filename collision wins and the ancestor duplicate is dropped', async () => {
    const parent = await makePlan(1, { title: 'Parent' });
    const child = await makePlan(2, { title: 'Child', parent: 1 });

    await attachArtifact(parent.uuid, 'shared.md', 'parent version');
    await attachArtifact(child.uuid, 'shared.md', 'child version');

    const artifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 2,
      repositoryId,
    });
    const result = await materializeReferenceArtifacts(repoRoot, 2, artifacts);

    expect(result.artifactPaths).toEqual([path.join(REFERENCE_ARTIFACTS_DIR, '2', 'shared.md')]);
    const written = await fs.readFile(path.join(repoRoot, result.artifactPaths[0]), 'utf8');
    expect(written).toBe('child version');
  });

  test('child-wins collision is case-insensitive on filename', async () => {
    const parent = await makePlan(1, { title: 'Parent' });
    const child = await makePlan(2, { title: 'Child', parent: 1 });

    await attachArtifact(parent.uuid, 'Shared.md', 'parent version');
    await attachArtifact(child.uuid, 'shared.md', 'child version');

    const artifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 2,
      repositoryId,
    });
    const result = await materializeReferenceArtifacts(repoRoot, 2, artifacts);

    expect(result.artifactPaths).toHaveLength(1);
    const written = await fs.readFile(path.join(repoRoot, result.artifactPaths[0]), 'utf8');
    expect(written).toBe('child version');
  });

  test('child-wins collision uses normalized per-plan-relative paths', async () => {
    const parent = await makePlan(1, { title: 'Parent' });
    const child = await makePlan(2, { title: 'Child', parent: 1 });

    await attachArtifact(parent.uuid, 'shared.md', 'parent version');
    const childArtifact = await attachArtifact(child.uuid, 'child-shared.md', 'child version');
    getDatabase()
      .prepare('UPDATE plan_artifact SET filename = ? WHERE uuid = ?')
      .run('dir/../shared.md', childArtifact.uuid);

    const artifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 2,
      repositoryId,
    });
    const result = await materializeReferenceArtifacts(repoRoot, 2, artifacts);

    expect(result.artifactPaths).toEqual([path.join(REFERENCE_ARTIFACTS_DIR, '2', 'shared.md')]);
    const written = await fs.readFile(path.join(repoRoot, result.artifactPaths[0]), 'utf8');
    expect(written).toBe('child version');
  });

  test('skips traversal filenames without writing outside the per-plan directory', async () => {
    const plan = await makePlan(1);
    const artifact = await attachArtifact(plan.uuid, 'safe.md', 'safe content');
    const targetDir = path.join(repoRoot, 'src');
    const targetPath = path.join(targetDir, 'target.ts');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(targetPath, 'original repo file');
    getDatabase()
      .prepare('UPDATE plan_artifact SET filename = ? WHERE uuid = ?')
      .run('../../../src/target.ts', artifact.uuid);

    const artifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 1,
      repositoryId,
    });
    const result = await materializeReferenceArtifacts(repoRoot, 1, artifacts);

    expect(result.artifactPaths).toEqual([]);
    await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('original repo file');
    await expect(fs.readdir(getReferenceArtifactsDir(repoRoot, 1))).resolves.toEqual([]);
  });

  test('clear-and-rebuild removes stale files from artifacts no longer present', async () => {
    const plan = await makePlan(1);
    const first = await attachArtifact(plan.uuid, 'first.md', 'first content');
    const second = await attachArtifact(plan.uuid, 'second.md', 'second content');

    const initialArtifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 1,
      repositoryId,
    });
    await materializeReferenceArtifacts(repoRoot, 1, initialArtifacts);

    const dir = getReferenceArtifactsDir(repoRoot, 1);
    expect((await fs.readdir(dir)).toSorted()).toEqual(['first.md', 'second.md']);

    // Remove "second" (soft-delete) so a fresh collect+materialize only includes "first".
    await softDeleteArtifact(second.uuid);
    const rebuiltArtifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 1,
      repositoryId,
    });
    await materializeReferenceArtifacts(repoRoot, 1, rebuiltArtifacts);

    const entriesAfterRebuild = await fs.readdir(dir);
    expect(entriesAfterRebuild).toEqual(['first.md']);
    expect(first.uuid).toBeTruthy();
  });

  test('materializeReferenceArtifactsForPlan collects and materializes in one call', async () => {
    const parent = await makePlan(1, { title: 'Parent' });
    const child = await makePlan(2, { title: 'Child', parent: 1 });
    await attachArtifact(parent.uuid, 'parent-design.md', 'parent design content');
    await attachArtifact(child.uuid, 'child-notes.md', 'child notes content');

    const result = await materializeReferenceArtifactsForPlan(repoRoot, 2, {
      repositoryId,
    });

    expect(result.artifactPaths.toSorted()).toEqual(
      [
        path.join(REFERENCE_ARTIFACTS_DIR, '2', 'child-notes.md'),
        path.join(REFERENCE_ARTIFACTS_DIR, '2', 'parent-design.md'),
      ].toSorted()
    );
    await expect(
      fs.readFile(path.join(repoRoot, REFERENCE_ARTIFACTS_DIR, '2', 'parent-design.md'), 'utf8')
    ).resolves.toBe('parent design content');
    await expect(
      fs.readFile(path.join(repoRoot, REFERENCE_ARTIFACTS_DIR, '2', 'child-notes.md'), 'utf8')
    ).resolves.toBe('child notes content');
  });

  test('preserves safe nested subpaths from artifact filenames', async () => {
    const plan = await makePlan(1);
    await attachArtifact(plan.uuid, 'runbook-1/screenshot.png', 'image bytes');

    const artifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 1,
      repositoryId,
    });
    const result = await materializeReferenceArtifacts(repoRoot, 1, artifacts);

    expect(result.artifactPaths).toEqual([
      path.join(REFERENCE_ARTIFACTS_DIR, '1', 'runbook-1', 'screenshot.png'),
    ]);
    await expect(fs.readFile(path.join(repoRoot, result.artifactPaths[0]), 'utf8')).resolves.toBe(
      'image bytes'
    );
  });

  test('materializeReferenceArtifactsForExecution resolves the workspace git root and materializes to the same deterministic path generate uses', async () => {
    // Simulates execution: the execution workspace root is discovered via git,
    // and the materialized path must match what materializeReferenceArtifactsForPlan
    // (used at generate time) produces for the same repoRoot/planId.
    await Bun.$`git init`.cwd(repoRoot).quiet();

    const parent = await makePlan(1, { title: 'Parent' });
    const child = await makePlan(2, { title: 'Child', parent: 1 });
    await attachArtifact(parent.uuid, 'parent-design.md', 'parent design content');
    await attachArtifact(child.uuid, 'child-notes.md', 'child notes content');

    // A nested subdirectory stands in for the actual "execution workspace" cwd,
    // which is still inside the same git repo as the primary checkout.
    const nestedExecutionDir = path.join(repoRoot, 'nested', 'workspace');
    await fs.mkdir(nestedExecutionDir, { recursive: true });

    const executionResult = await materializeReferenceArtifactsForExecution(nestedExecutionDir, 2);

    expect(executionResult.artifactPaths.toSorted()).toEqual(
      [
        path.join(REFERENCE_ARTIFACTS_DIR, '2', 'child-notes.md'),
        path.join(REFERENCE_ARTIFACTS_DIR, '2', 'parent-design.md'),
      ].toSorted()
    );
    await expect(
      fs.readFile(path.join(repoRoot, REFERENCE_ARTIFACTS_DIR, '2', 'parent-design.md'), 'utf8')
    ).resolves.toBe('parent design content');
    await expect(
      fs.readFile(path.join(repoRoot, REFERENCE_ARTIFACTS_DIR, '2', 'child-notes.md'), 'utf8')
    ).resolves.toBe('child notes content');
  });

  test('materializeReferenceArtifactsForExecution registers .tim/reference-artifacts in .git/info/exclude in a fresh repo', async () => {
    // Plan materialization was never run in this repo before, so ensureMaterializeDir
    // must be invoked by materializeReferenceArtifactsForExecution itself.
    await Bun.$`git init`.cwd(repoRoot).quiet();

    const plan = await makePlan(1);
    await attachArtifact(plan.uuid, 'spec.md', 'spec content');

    await materializeReferenceArtifactsForExecution(repoRoot, 1);

    const infoExcludePath = path.join(repoRoot, '.git', 'info', 'exclude');
    const lines = (await fs.readFile(infoExcludePath, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.filter((line) => line === '.tim/reference-artifacts')).toHaveLength(1);
  });

  test('addArtifact via numeric planId with reference marker is collected the same as addArtifactByPlanUuid', async () => {
    const plan = await makePlan(1);
    const sourcePath = path.join(sourceDir, 'numeric-plan-id.md');
    await fs.writeFile(sourcePath, 'numeric plan id content');
    await addArtifact({
      planId: plan.id,
      sourcePath,
      message: buildReferenceArtifactMessage('via numeric planId'),
      repoRoot,
    });

    const artifacts = await collectReferenceArtifacts({
      searchDir: repoRoot,
      planId: 1,
      repositoryId,
    });

    expect(artifacts.map((a) => a.filename)).toEqual(['numeric-plan-id.md']);
  });
});
