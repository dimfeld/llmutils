import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getTimDataDir } from '../../common/config_paths.js';

export function getDefaultWorkspaceCloneLocation(mainRepoRoot: string): string {
  const resolvedRoot = path.resolve(mainRepoRoot);
  const rootHash = createHash('sha256').update(resolvedRoot).digest('hex');
  return path.join(getTimDataDir(), 'workspaces', `${path.basename(resolvedRoot)}-${rootHash}`);
}
