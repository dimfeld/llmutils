import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { debugLog, warn } from '../../../logging.js';

const PROJECT_SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const;
const PERMISSION_RULE_KEYS = ['allow', 'ask', 'deny'] as const;

type PermissionRuleKey = (typeof PERMISSION_RULE_KEYS)[number];

/**
 * Claude Code ignores `permissions.allow` entries from a project's `.claude/settings*.json`
 * when the directory has not been trusted (for example, a newly created workspace). Entries
 * passed through `--settings` still apply. This reads the permission rules from the project
 * settings files in `cwd` and returns them as a JSON string for `--settings`, or undefined
 * when there are no rules.
 */
export async function loadClaudeProjectPermissionSettings(
  cwd: string
): Promise<string | undefined> {
  const rules: Record<PermissionRuleKey, Set<string>> = {
    allow: new Set(),
    ask: new Set(),
    deny: new Set(),
  };

  for (const fileName of PROJECT_SETTINGS_FILES) {
    const filePath = path.join(cwd, '.claude', fileName);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        debugLog(`Could not read ${filePath}: ${String(error)}`);
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      warn(
        `Could not parse ${filePath}, so its permissions are not passed to Claude: ${String(error)}`
      );
      continue;
    }

    const permissions = (parsed as { permissions?: unknown } | null)?.permissions;
    if (!permissions || typeof permissions !== 'object') {
      continue;
    }

    for (const key of PERMISSION_RULE_KEYS) {
      const entries = (permissions as Record<string, unknown>)[key];
      if (!Array.isArray(entries)) {
        continue;
      }
      for (const entry of entries) {
        if (typeof entry === 'string' && entry.trim()) {
          rules[key].add(entry);
        }
      }
    }
  }

  const permissions: Partial<Record<PermissionRuleKey, string[]>> = {};
  for (const key of PERMISSION_RULE_KEYS) {
    if (rules[key].size) {
      permissions[key] = [...rules[key]];
    }
  }

  if (!Object.keys(permissions).length) {
    return undefined;
  }

  return JSON.stringify({ permissions });
}
