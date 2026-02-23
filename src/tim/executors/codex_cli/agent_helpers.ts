import * as path from 'path';
import type { TimConfig } from '../../configSchema';
import { log } from '../../../logging';

/** Load agent instructions if configured in timConfig */
export async function loadAgentInstructionsFor(
  agent: 'implementer' | 'tester' | 'tddTests' | 'reviewer',
  gitRoot: string,
  timConfig: TimConfig
): Promise<string | undefined> {
  try {
    const p = timConfig.agents?.[agent]?.instructions;
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
  timConfig: TimConfig
): Promise<string | undefined> {
  try {
    const p = timConfig.review?.customInstructionsPath;
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

export function timestamp(): string {
  return new Date().toISOString();
}
