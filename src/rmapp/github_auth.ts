import { App, Octokit } from 'octokit';
import type { GitHubAppConfig } from './types';
import { error } from '../logging';

export class GitHubAuth {
  private app: App;

  constructor(private config: GitHubAppConfig) {
    this.app = new App({
      appId: this.config.appId,
      privateKey: this.config.privateKey,
    });
  }

  async getInstallationOctokit(installationId: number): Promise<Octokit | null> {
    try {
      const octokit = await this.app.getInstallationOctokit(installationId);
      return octokit;
    } catch (e) {
      error('Failed to get installation Octokit:', e);
      return null;
    }
  }

  async verifyInstallation(installationId: number): Promise<boolean> {
    try {
      const octokit = await this.getInstallationOctokit(installationId);
      if (!octokit) return false;

      // Test the authentication by making a simple API call
      await octokit.rest.apps.getAuthenticated();
      return true;
    } catch (e) {
      error('Installation verification failed:', e);
      return false;
    }
  }
}
