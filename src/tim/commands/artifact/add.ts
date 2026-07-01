import chalk from 'chalk';
import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../../../logging.js';
import { parsePlanIdFromCliArg } from '../../plans.js';
import { buildProofArtifactMessage } from '../../artifacts/proof.js';
import { buildReferenceArtifactMessage } from '../../artifacts/reference.js';
import { addArtifact } from '../../artifacts/service.js';
import { createZip, type ZipEntryInput } from '../../artifacts/zip.js';
import { printJson, resolveArtifactCommandContext, serializeArtifactForCli } from './common.js';

export interface ArtifactAddOptions {
  message?: string;
  reference?: boolean;
  proof?: boolean;
  zip?: boolean;
  json?: boolean;
}

export async function handleArtifactAddCommand(
  planIdArg: string,
  files: string[],
  options: ArtifactAddOptions = {},
  command?: Command
): Promise<void> {
  if (!options.reference && !options.proof) {
    throw new Error('Specify how to attach the artifact: pass either --reference or --proof.');
  }
  if (options.reference && options.proof) {
    throw new Error('An artifact cannot be both --reference and --proof.');
  }
  if (files.length === 0) {
    throw new Error('At least one file is required.');
  }
  if (!options.zip && files.length > 1) {
    throw new Error('Multiple files can only be attached together with --zip.');
  }

  const planId = parsePlanIdFromCliArg(planIdArg);
  const context = await resolveArtifactCommandContext(command);
  const message = options.reference
    ? buildReferenceArtifactMessage(options.message)
    : buildProofArtifactMessage(options.message);

  const prepared = options.zip
    ? await buildZipArtifactFile(files)
    : { sourcePath: files[0]!, cleanup: undefined as (() => Promise<void>) | undefined };

  try {
    const artifact = await addArtifact({
      planId,
      sourcePath: prepared.sourcePath,
      message,
      config: context.config,
      repoRoot: context.repoRoot,
    });

    if (options.json) {
      printJson(serializeArtifactForCli(artifact));
      return;
    }

    log(
      `${chalk.green('Attached artifact:')} ${artifact.uuid} (${artifact.size} bytes, ${artifact.mimeType})`
    );
  } finally {
    await prepared.cleanup?.();
  }
}

interface PreparedArtifactFile {
  sourcePath: string;
  cleanup?: () => Promise<void>;
}

/**
 * Zip the given files/directories into a single temporary ZIP file and return
 * its path plus a cleanup callback. Directory inputs contribute their contents
 * (relative to the directory), so the extracted layout mirrors the directory.
 */
async function buildZipArtifactFile(inputs: string[]): Promise<PreparedArtifactFile> {
  const entries = await collectZipEntries(inputs);
  if (entries.length === 0) {
    throw new Error('No files found to zip.');
  }

  const archiveName = await deriveArchiveName(inputs);
  const zip = createZip(entries);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-artifact-zip-'));
  const zipPath = path.join(tempDir, archiveName);
  await fs.writeFile(zipPath, zip);

  return {
    sourcePath: zipPath,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function collectZipEntries(inputs: string[]): Promise<ZipEntryInput[]> {
  const entries: ZipEntryInput[] = [];
  const usedNames = new Set<string>();

  for (const input of inputs) {
    const resolved = path.resolve(process.cwd(), input);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      for (const relative of await walkDirectory(resolved)) {
        const data = await fs.readFile(path.join(resolved, relative));
        entries.push({ filename: dedupeName(relative, usedNames), data });
      }
    } else {
      const data = await fs.readFile(resolved);
      entries.push({ filename: dedupeName(path.basename(resolved), usedNames), data });
    }
  }

  return entries;
}

async function walkDirectory(dir: string): Promise<string[]> {
  const results: string[] = [];
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const childPath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      for (const nested of await walkDirectory(childPath)) {
        results.push(path.join(dirent.name, nested));
      }
    } else if (dirent.isFile()) {
      results.push(dirent.name);
    }
  }
  return results;
}

function dedupeName(name: string, used: Set<string>): string {
  // Normalize path separators so ZIP entry names are always forward-slashed.
  const normalized = name.split(path.sep).join('/');
  if (!used.has(normalized)) {
    used.add(normalized);
    return normalized;
  }

  const parsed = path.parse(normalized);
  let index = 2;
  let candidate = `${parsed.dir ? `${parsed.dir}/` : ''}${parsed.name} (${index})${parsed.ext}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${parsed.dir ? `${parsed.dir}/` : ''}${parsed.name} (${index})${parsed.ext}`;
  }
  used.add(candidate);
  return candidate;
}

async function deriveArchiveName(inputs: string[]): Promise<string> {
  if (inputs.length === 1) {
    const resolved = path.resolve(process.cwd(), inputs[0]!);
    const stat = await fs.stat(resolved);
    const base = path.basename(resolved);
    return stat.isDirectory() ? `${base}.zip` : `${path.parse(base).name}.zip`;
  }
  return 'artifacts.zip';
}
