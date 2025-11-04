import * as path from 'path';
import type { RmplanConfig } from '../../configSchema';
import { log } from '../../../logging';

/** Load agent instructions if configured in rmplanConfig */
export async function loadAgentInstructionsFor(
  agent: 'implementer' | 'tester' | 'reviewer',
  gitRoot: string,
  rmplanConfig: RmplanConfig
): Promise<string | undefined> {
  try {
    const p = rmplanConfig.agents?.[agent]?.instructions;
    if (!p) return undefined;
    const resolved = path.isAbsolute(p) ? p : path.join(gitRoot, p);
    const file = Bun.file(resolved);
    if (!(await file.exists())) return undefined;
    const content = await file.text();
    log(`Including ${agent} instructions: ${path.relative(gitRoot, resolved)}`);
    return content;
  } catch (e) {
    // Non-fatal
    return undefined;
  }
}

/** Load repository-specific review guidance document if configured */
export async function loadRepositoryReviewDoc(
  gitRoot: string,
  rmplanConfig: RmplanConfig
): Promise<string | undefined> {
  try {
    const p = rmplanConfig.review?.customInstructionsPath;
    if (!p) return undefined;
    const resolved = path.isAbsolute(p) ? p : path.join(gitRoot, p);
    const file = Bun.file(resolved);
    if (!(await file.exists())) return undefined;
    const content = await file.text();
    log(`Including repository review guidance: ${path.relative(gitRoot, resolved)}`);
    return content;
  } catch {
    return undefined;
  }
}
