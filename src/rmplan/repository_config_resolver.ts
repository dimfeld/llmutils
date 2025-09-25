import { $ } from 'bun';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { getGitRoot } from '../common/git.js';
import {
  deriveRepositoryName,
  fallbackRepositoryNameFromGitRoot,
  parseGitRemoteUrl,
} from '../common/git_url_parser.js';
import { debugLog } from '../logging.js';

export interface RepositoryConfigResolution {
  configPath: string | null;
  usingExternalStorage: boolean;
  repositoryConfigDir?: string;
  externalConfigPath?: string;
  externalTasksDir?: string;
  repositoryName?: string;
  remoteUrl?: string | null;
  gitRoot?: string;
}

export interface RepositoryConfigResolverOptions {
  overridePath?: string;
  cwd?: string;
}

export class RepositoryConfigResolver {
  private readonly overridePath?: string;
  private readonly cwd?: string;
  private gitRoot?: string;

  private constructor(options: RepositoryConfigResolverOptions) {
    this.overridePath = options.overridePath;
    this.cwd = options.cwd;
  }

  static async create(
    options: RepositoryConfigResolverOptions = {}
  ): Promise<RepositoryConfigResolver> {
    const resolver = new RepositoryConfigResolver(options);
    resolver.gitRoot = await getGitRoot(options.cwd);
    return resolver;
  }

  async resolve(): Promise<RepositoryConfigResolution> {
    if (this.overridePath) {
      const absoluteOverridePath = path.resolve(this.overridePath);
      const fileExists = await Bun.file(absoluteOverridePath).exists();
      if (!fileExists) {
        throw new Error(`Specified configuration file not found: ${absoluteOverridePath}`);
      }

      debugLog(`Using configuration file specified via override: ${absoluteOverridePath}`);
      return {
        configPath: absoluteOverridePath,
        usingExternalStorage: false,
        gitRoot: this.gitRoot,
      };
    }

    const gitRoot = this.gitRoot ?? (await getGitRoot(this.cwd));
    const localConfigPath = path.join(gitRoot, '.rmfilter', 'config', 'rmplan.yml');
    const hasLocalConfig = await Bun.file(localConfigPath).exists();

    if (hasLocalConfig) {
      debugLog(`Found repository configuration at ${localConfigPath}`);
      return {
        configPath: localConfigPath,
        usingExternalStorage: false,
        gitRoot,
      };
    }

    return await this.resolveExternalConfig(gitRoot);
  }

  private async resolveExternalConfig(gitRoot: string): Promise<RepositoryConfigResolution> {
    const remoteUrl = await this.getOriginRemote(gitRoot);
    const parsedRemote = remoteUrl ? parseGitRemoteUrl(remoteUrl) : null;
    const fallbackName = fallbackRepositoryNameFromGitRoot(gitRoot);
    const repositoryName = deriveRepositoryName(parsedRemote, {
      fallbackName,
      uniqueSalt: gitRoot,
    });

    const repositoryConfigDir = path.join(
      os.homedir(),
      '.config',
      'rmfilter',
      'repositories',
      repositoryName
    );
    const externalConfigDir = path.join(repositoryConfigDir, '.rmfilter', 'config');
    const externalTasksDir = path.join(repositoryConfigDir, 'tasks');

    await fs.mkdir(externalConfigDir, { recursive: true });
    await fs.mkdir(externalTasksDir, { recursive: true });

    const externalConfigPath = path.join(externalConfigDir, 'rmplan.yml');

    debugLog(`Using external rmplan storage at ${repositoryConfigDir}`);

    return {
      configPath: externalConfigPath,
      usingExternalStorage: true,
      repositoryConfigDir,
      externalConfigPath,
      externalTasksDir,
      repositoryName,
      remoteUrl,
      gitRoot,
    };
  }

  private async getOriginRemote(gitRoot: string): Promise<string | null> {
    const remoteResult = await $`git remote get-url origin`.cwd(gitRoot).quiet().nothrow();
    if (remoteResult.exitCode !== 0) {
      return null;
    }

    const remote = remoteResult.stdout.toString().trim();
    return remote.length > 0 ? remote : null;
  }
}
