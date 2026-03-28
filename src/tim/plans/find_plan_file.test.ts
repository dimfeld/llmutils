import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getMaterializedPlanPath } from '../plan_materialize.js';
import { findPlanFileOnDisk, findPlanFileOnDiskAsync } from './find_plan_file.js';

const schemaLine =
  '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';

async function makeRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-find-plan-file-'));
  await fs.mkdir(path.join(repoRoot, '.tim', 'plans'), { recursive: true });
  return repoRoot;
}

async function writePlan(
  repoRoot: string,
  filename: string,
  id: number,
  title = `Plan ${id}`,
  options?: { lineEnding?: '\n' | '\r\n' }
): Promise<string> {
  const planPath = path.join(repoRoot, '.tim', 'plans', filename);
  const lineEnding = options?.lineEnding ?? '\n';
  await fs.writeFile(
    planPath,
    `${schemaLine.replaceAll('\n', lineEnding)}---${lineEnding}id: ${id}${lineEnding}title: ${title}${lineEnding}status: pending${lineEnding}tasks: []${lineEnding}---${lineEnding}`
  );
  return planPath;
}

describe('find_plan_file', () => {
  const repos: string[] = [];

  afterEach(async () => {
    await Promise.all(repos.map((repoRoot) => fs.rm(repoRoot, { recursive: true, force: true })));
    repos.length = 0;
  });

  test('prefers the materialized convention path when it exists', async () => {
    const repoRoot = await makeRepo();
    repos.push(repoRoot);

    const materializedPath = getMaterializedPlanPath(repoRoot, 289);
    await fs.writeFile(
      materializedPath,
      `${schemaLine}---\nid: 289\ntitle: Materialized\nstatus: pending\ntasks: []\n---\n`
    );
    await writePlan(repoRoot, '289-legacy.plan.md', 289, 'Legacy');

    expect(findPlanFileOnDisk(289, repoRoot)).toBe(materializedPath);
    expect(await findPlanFileOnDiskAsync(289, repoRoot)).toBe(materializedPath);
  });

  test('finds a legacy prefixed plan file when the materialized file is absent', async () => {
    const repoRoot = await makeRepo();
    repos.push(repoRoot);

    const legacyPath = await writePlan(repoRoot, '289-remove-filename.plan.md', 289);

    expect(findPlanFileOnDisk(289, repoRoot)).toBe(legacyPath);
    expect(await findPlanFileOnDiskAsync(289, repoRoot)).toBe(legacyPath);
  });

  test('ignores the materialized convention path when its frontmatter id does not match', async () => {
    const repoRoot = await makeRepo();
    repos.push(repoRoot);

    const materializedPath = getMaterializedPlanPath(repoRoot, 289);
    await fs.writeFile(
      materializedPath,
      `${schemaLine}---\nid: 1\ntitle: Wrong ID\nstatus: pending\ntasks: []\n---\n`
    );
    const fallbackPath = await writePlan(repoRoot, 'actual-match.plan.md', 289, 'Actual Match');

    expect(findPlanFileOnDisk(289, repoRoot)).toBe(fallbackPath);
    expect(await findPlanFileOnDiskAsync(289, repoRoot)).toBe(fallbackPath);
  });

  test('falls back to matching the frontmatter id when there is no filename match', async () => {
    const repoRoot = await makeRepo();
    repos.push(repoRoot);

    const frontmatterMatch = await writePlan(repoRoot, 'mismatched-name.plan.md', 289);
    await writePlan(repoRoot, '123-other.plan.md', 123);

    expect(findPlanFileOnDisk(289, repoRoot)).toBe(frontmatterMatch);
    expect(await findPlanFileOnDiskAsync(289, repoRoot)).toBe(frontmatterMatch);
  });

  test('returns null when no matching plan file exists', async () => {
    const repoRoot = await makeRepo();
    repos.push(repoRoot);

    await writePlan(repoRoot, '100.plan.md', 100);
    await writePlan(repoRoot, 'other.plan.md', 101);

    expect(findPlanFileOnDisk(289, repoRoot)).toBeNull();
    expect(await findPlanFileOnDiskAsync(289, repoRoot)).toBeNull();
  });

  test('returns null when the .tim/plans directory does not exist', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-find-plan-file-missing-dir-'));
    repos.push(repoRoot);

    expect(findPlanFileOnDisk(289, repoRoot)).toBeNull();
    expect(await findPlanFileOnDiskAsync(289, repoRoot)).toBeNull();
  });

  test('ignores unrelated files and only returns the matching plan', async () => {
    const repoRoot = await makeRepo();
    repos.push(repoRoot);

    await writePlan(repoRoot, '288-other.plan.md', 288);
    const matchingPath = await writePlan(repoRoot, '289-correct.plan.md', 289);
    await fs.writeFile(path.join(repoRoot, '.tim', 'plans', '289.txt'), 'not a plan file');

    expect(findPlanFileOnDisk(289, repoRoot)).toBe(matchingPath);
    expect(await findPlanFileOnDiskAsync(289, repoRoot)).toBe(matchingPath);
  });

  test('prefers a legacy prefix match over a frontmatter-only match', async () => {
    const repoRoot = await makeRepo();
    repos.push(repoRoot);

    const prefixMatch = await writePlan(repoRoot, '289-legacy.plan.md', 289, 'Legacy');
    await writePlan(repoRoot, 'unrelated-name.plan.md', 289, 'Frontmatter only');

    expect(findPlanFileOnDisk(289, repoRoot)).toBe(prefixMatch);
    expect(await findPlanFileOnDiskAsync(289, repoRoot)).toBe(prefixMatch);
  });

  test('ignores a legacy prefix match when its frontmatter id does not match', async () => {
    const repoRoot = await makeRepo();
    repos.push(repoRoot);

    await writePlan(repoRoot, '289-legacy.plan.md', 1, 'Wrong Prefix ID');
    const fallbackPath = await writePlan(repoRoot, 'actual-match.plan.md', 289, 'Actual Match');

    expect(findPlanFileOnDisk(289, repoRoot)).toBe(fallbackPath);
    expect(await findPlanFileOnDiskAsync(289, repoRoot)).toBe(fallbackPath);
  });

  test('does not match similarly prefixed plan ids when multiple files exist', async () => {
    const repoRoot = await makeRepo();
    repos.push(repoRoot);

    await writePlan(repoRoot, '28-other.plan.md', 28);
    await writePlan(repoRoot, '2890-other.plan.md', 2890);
    const matchingPath = await writePlan(repoRoot, '289-target.plan.md', 289);

    expect(findPlanFileOnDisk(289, repoRoot)).toBe(matchingPath);
    expect(await findPlanFileOnDiskAsync(289, repoRoot)).toBe(matchingPath);
  });

  test('skips malformed yaml files and continues scanning for a valid match', async () => {
    const repoRoot = await makeRepo();
    repos.push(repoRoot);

    await fs.writeFile(
      path.join(repoRoot, '.tim', 'plans', 'broken.plan.md'),
      `${schemaLine}---\nid: [289\n`
    );
    const matchingPath = await writePlan(repoRoot, 'valid.plan.md', 289);

    expect(findPlanFileOnDisk(289, repoRoot)).toBe(matchingPath);
    expect(await findPlanFileOnDiskAsync(289, repoRoot)).toBe(matchingPath);
  });

  test('parses frontmatter with CRLF line endings', async () => {
    const repoRoot = await makeRepo();
    repos.push(repoRoot);

    const matchingPath = await writePlan(repoRoot, 'crlf.plan.md', 289, 'CRLF', {
      lineEnding: '\r\n',
    });

    expect(findPlanFileOnDisk(289, repoRoot)).toBe(matchingPath);
    expect(await findPlanFileOnDiskAsync(289, repoRoot)).toBe(matchingPath);
  });
});
